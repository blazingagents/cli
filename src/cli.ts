import {
  BlazingAgentsError,
  type BlazingAgentsOptions,
} from "@blazingagents/sdk";
import { sessionIdSchema } from "@blazingagents/sdk/contracts";
import {
  Command,
  CommanderError,
  InvalidArgumentError,
  Option,
} from "commander";
import { AgentSelectionError } from "./agent-resolution.ts";
import { AssistOperationalError, executeAssist } from "./assist.ts";
import {
  AuthenticationError,
  login as loginToWorkstation,
  logout as logoutFromWorkstation,
  resolveAuthentication,
  showAuthenticationStatus,
} from "./authentication.ts";
import { ChatOperationalError, executeChat } from "./chat.ts";
import {
  type ConfigurationError,
  parseBaseUrl,
  resolveConfiguration,
} from "./config.ts";
import { promptIdSchema } from "./contracts.ts";
import {
  type CredentialStoreLoader,
  loadNativeCredentialStore,
} from "./credentials.ts";
import { executeRun, type RunSignal } from "./run.ts";
import {
  collectPromptVariable,
  parseMetadata,
  prepareRunOptions,
  type RunCommandOptions,
  RunInvocationError,
} from "./run-input.ts";
import { RunOperationalError, safePreview } from "./run-output.ts";
import type { TuiLoader } from "./tui.ts";

const ERROR_METADATA_VALUE_LIMIT = 160;

function formatErrorMetadataValue(value: string): string {
  const singleLine = value.replaceAll(/\s+/g, " ");
  return singleLine.length <= ERROR_METADATA_VALUE_LIMIT
    ? singleLine
    : `${singleLine.slice(0, ERROR_METADATA_VALUE_LIMIT - 1)}…`;
}

function formatBlazingAgentsError(error: BlazingAgentsError): string {
  const metadata = [
    `code=${formatErrorMetadataValue(error.code)}`,
    ...(error.status === undefined ? [] : [`status=${error.status}`]),
    ...(error.requestId === undefined
      ? []
      : [`requestId=${formatErrorMetadataValue(error.requestId)}`]),
    ...(error.param === undefined
      ? []
      : [`param=${formatErrorMetadataValue(error.param)}`]),
    ...(error.details === undefined
      ? []
      : [`details=${safePreview(error.details)}`]),
  ];
  return `${error.message.replaceAll(/\s+/g, " ")} [${metadata.join(" ")}]\n`;
}

function parseSessionId(value: string): string {
  const parsed = sessionIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidArgumentError(
      "Invalid Session id; expected ss_ followed by 16 base62 characters."
    );
  }
  return parsed.data;
}

function parsePromptId(value: string): string {
  const parsed = promptIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidArgumentError(
      "Invalid Prompt id; expected prompt_ followed by 16 base62 characters."
    );
  }
  return parsed.data;
}

export interface CliRuntime {
  environment?: NodeJS.ProcessEnv;
  fetch?: BlazingAgentsOptions["fetch"];
  homeDirectory?: string;
  hostname?: string;
  loadCredentialStore?: CredentialStoreLoader;
  loadTui?: TuiLoader;
  onSignal?: (signal: RunSignal, listener: () => void) => () => void;
  platform?: NodeJS.Platform;
  readSecret?: (prompt: string) => Promise<string>;
  readStdin?: () => Promise<string>;
  stderr: (text: string) => void;
  stderrIsTTY?: boolean;
  stdinIsTTY?: boolean;
  stdout: (text: string) => void;
  stdoutIsTTY?: boolean;
  version: string;
}

export async function executeCli(
  args: readonly string[],
  runtime: CliRuntime
): Promise<number> {
  const environment = runtime.environment ?? process.env;
  const loadCredentialStore =
    runtime.loadCredentialStore ?? loadNativeCredentialStore;
  let operationalExitCode = 0;
  const bold = (text: string) => `\u001B[1m${text}\u001B[22m`;
  const cyan = (text: string) => `\u001B[36m${text}\u001B[39m`;

  const program = new Command()
    .name("ba")
    .description("The Blazing Agents developer CLI")
    .version(runtime.version)
    .addOption(
      new Option(
        "--base-url <url>",
        "override the Blazing Agents API base URL"
      ).argParser((value) => {
        const result = parseBaseUrl(value, "--base-url");
        if (!result.success) {
          throw new InvalidArgumentError(result.error);
        }
        return result.value;
      })
    )
    .addOption(
      new Option(
        "--login",
        "log in using the native credential store"
      ).conflicts(["logout", "status"])
    )
    .addOption(
      new Option(
        "--logout",
        "log out from the native credential store"
      ).conflicts(["login", "status"])
    )
    .addOption(
      new Option("--status", "show authentication status").conflicts([
        "login",
        "logout",
      ])
    )
    .addHelpCommand(false)
    .showHelpAfterError()
    .showSuggestionAfterError(false)
    .configureHelp({
      styleArgumentText: cyan,
      styleOptionText: cyan,
      styleSubcommandText: cyan,
      styleTitle: bold,
    })
    .configureOutput({
      getErrHasColors: () => Boolean(runtime.stderrIsTTY),
      getOutHasColors: () => Boolean(runtime.stdoutIsTTY),
      writeErr: runtime.stderr,
      writeOut: runtime.stdout,
    })
    .exitOverride();

  program.hook("preSubcommand", (rootCommand) => {
    const { login, logout, status } = rootCommand.opts<{
      login?: boolean;
      logout?: boolean;
      status?: boolean;
    }>();
    if (login || logout || status) {
      rootCommand.error(
        "error: a credential action cannot be combined with a product command",
        { code: "ba.invalidCombination", exitCode: 2 }
      );
    }
  });

  const validateConfiguration = async (command: Command) =>
    resolveConfiguration({
      baseUrl: program.opts<{ baseUrl?: string }>().baseUrl,
      environment: runtime.environment,
      homeDirectory: runtime.homeDirectory,
      platform: runtime.platform,
    }).catch((error: ConfigurationError) => {
      command.error(`error: ${error.message}`, {
        code: "ba.configuration",
        exitCode: 2,
      });
    });

  const authenticationOptions = {
    environment,
    loadCredentialStore,
  };

  program
    .command("assist")
    .description("administer Blazing Agents interactively")
    .option("--session <id>", "resume an existing Session", parseSessionId)
    .action(async (options: { session?: string }, command) => {
      if (!(runtime.stdinIsTTY && runtime.stdoutIsTTY)) {
        throw new AssistOperationalError(
          "BA Assist requires an interactive terminal on stdin and stdout. Use ba run for non-interactive input."
        );
      }
      const configuration = await validateConfiguration(command);
      const authentication = await resolveAuthentication({
        configuration,
        ...authenticationOptions,
      });
      await executeAssist({
        apiKey: authentication.token,
        configuration,
        fetch: runtime.fetch,
        loadTui: runtime.loadTui,
        onSignal: runtime.onSignal,
        sessionId: options.session,
        stdout: runtime.stdout,
      });
    });
  program
    .command("chat <agent>")
    .description("chat with an Agent interactively")
    .option("--session <id>", "resume an existing Session", parseSessionId)
    .action(async (agent, options: { session?: string }, command) => {
      if (!(runtime.stdinIsTTY && runtime.stdoutIsTTY)) {
        throw new ChatOperationalError(
          "Chat requires an interactive terminal on stdin and stdout. Use ba run for non-interactive input."
        );
      }
      const configuration = await validateConfiguration(command);
      const authentication = await resolveAuthentication({
        configuration,
        ...authenticationOptions,
      });
      await executeChat({
        agentSelector: agent,
        apiKey: authentication.token,
        configuration,
        fetch: runtime.fetch,
        loadTui: runtime.loadTui,
        sessionId: options.session,
        stdout: runtime.stdout,
      });
    });
  program
    .command("run <agent>")
    .description("run one Agent turn")
    .addOption(
      new Option("--prompt <text>", "use a literal prompt").conflicts(
        "promptId"
      )
    )
    .addOption(
      new Option("--prompt-id <id>", "invoke a stored Prompt").argParser(
        parsePromptId
      )
    )
    .option(
      "--var <key=value>",
      "set a stored Prompt variable",
      (value, previous: Record<string, string>) => {
        try {
          return collectPromptVariable(value, previous);
        } catch (error) {
          const argumentError = new InvalidArgumentError(
            (error as Error).message
          );
          argumentError.cause = error;
          throw argumentError;
        }
      },
      {}
    )
    .addOption(
      new Option("--session <id>", "resume an existing Session").argParser(
        parseSessionId
      )
    )
    .option("--user-id <value>", "attribute the Turn to an end-user")
    .option(
      "--metadata <json>",
      "attach JSON-object Attribution metadata",
      (value) => {
        try {
          return parseMetadata(value);
        } catch (error) {
          const argumentError = new InvalidArgumentError(
            (error as Error).message
          );
          argumentError.cause = error;
          throw argumentError;
        }
      }
    )
    .option("--json", "buffer and emit one JSON document")
    .addOption(
      new Option(
        "--schema <file>",
        "generate output matching a JSON Schema"
      ).conflicts("session")
    )
    .addOption(
      new Option("--tool-output <mode>", "set Tool diagnostics")
        .choices(["summary", "off"])
        .default("summary")
    )
    .action(async (agent, rawOptions, command) => {
      const configuration = await validateConfiguration(command);
      let options: RunCommandOptions;
      try {
        options = await prepareRunOptions({
          options: rawOptions,
          ...(runtime.stdinIsTTY
            ? {}
            : { stdin: (await runtime.readStdin?.()) ?? "" }),
        });
      } catch (error) {
        if (error instanceof RunInvocationError) {
          command.error(`error: ${error.message}`, {
            code: "ba.runInvocation",
            exitCode: 2,
          });
        }
        throw error;
      }
      const authentication = await resolveAuthentication({
        configuration,
        ...authenticationOptions,
      });
      try {
        operationalExitCode = await executeRun({
          agentSelector: agent,
          apiKey: authentication.token,
          configuration,
          fetch: runtime.fetch,
          onSignal: runtime.onSignal,
          options,
          stderr: runtime.stderr,
          stdout: runtime.stdout,
        });
      } catch (error) {
        if (error instanceof RunInvocationError) {
          command.error(`error: ${error.message}`, {
            code: "ba.runInvocation",
            exitCode: 2,
          });
        }
        throw error;
      }
    });
  program.action(async () => {
    const { login, logout, status } = program.opts<{
      login?: boolean;
      logout?: boolean;
      status?: boolean;
    }>();
    if (login || logout || status) {
      const configuration = await validateConfiguration(program);
      if (login) {
        if (!runtime.readSecret) {
          throw new AuthenticationError(
            "Login requires an interactive terminal."
          );
        }
        const result = await loginToWorkstation({
          configuration,
          hostname: runtime.hostname ?? "unknown-host",
          loadCredentialStore,
          printDashboardUrl: (url) => runtime.stderr(`${url}\n`),
          readSecret: runtime.readSecret,
          stdinIsTTY: Boolean(runtime.stdinIsTTY),
          fetch: runtime.fetch,
        });
        runtime.stdout(result.stdout);
        runtime.stderr(result.stderr);
      } else if (logout) {
        const result = await logoutFromWorkstation({
          configuration,
          environment,
          loadCredentialStore,
        });
        runtime.stdout(result.stdout);
        runtime.stderr(result.stderr);
      } else {
        const result = await showAuthenticationStatus({
          configuration,
          environment,
          fetch: runtime.fetch,
          loadCredentialStore,
        });
        runtime.stdout(result.stdout);
        operationalExitCode = result.exitCode;
      }
      return;
    }
    program.outputHelp();
  });

  try {
    await program.parseAsync([...args], { from: "user" });
    return operationalExitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? 0 : 2;
    }
    if (error instanceof AuthenticationError) {
      runtime.stderr(`${error.message}\n`);
      return 1;
    }
    if (
      error instanceof AssistOperationalError ||
      error instanceof ChatOperationalError ||
      error instanceof RunOperationalError
    ) {
      runtime.stderr(`${error.message}\n`);
      return 1;
    }
    if (
      error instanceof AgentSelectionError ||
      BlazingAgentsError.isInstance(error)
    ) {
      runtime.stderr(
        BlazingAgentsError.isInstance(error)
          ? formatBlazingAgentsError(error)
          : `${error.message}\n`
      );
      return 1;
    }
    throw error;
  }
}
