import { randomUUID } from "node:crypto";
import {
  type Agent,
  BlazingAgents,
  type BlazingAgentsOptions,
} from "@blazingagents/sdk";
import { z } from "zod";
import { resolveAgent } from "./agent-resolution.ts";
import type { ResolvedConfiguration } from "./config.ts";
import { isAdminAgentId } from "./contracts.ts";
import {
  type RunCommandOptions,
  type RunExecutionMode,
  validatePromptVariables,
} from "./run-input.ts";
import { consumeSessionStream, RunOperationalError } from "./run-output.ts";
import { decodeUIMessageResponse } from "./ui-message-stream.ts";

export type RunSignal = "SIGINT" | "SIGTERM";

type SdkPromptInput =
  | { prompt: string; promptId?: never; variables?: never }
  | {
      prompt?: never;
      promptId: string;
      variables: Record<string, string>;
    };

interface RunModeContext {
  abortSignal: AbortSignal;
  agent: Agent;
  client: BlazingAgents;
  now: () => number;
  promptInput: SdkPromptInput;
  stderr: (text: string) => void;
  stdout: (text: string) => void;
}

async function executeSchemaMode(
  { abortSignal, agent, client, promptInput }: RunModeContext,
  options: RunCommandOptions & Extract<RunExecutionMode, { mode: "schema" }>
): Promise<unknown> {
  const { schema } = options;
  const result = await client.object({
    agentId: agent.id,
    metadata: options.metadata,
    ...promptInput,
    schema,
    signal: abortSignal,
    userId: options.userId,
  });
  const output = await result.object;
  const validation = z.fromJSONSchema(schema).safeParse(output);
  if (!validation.success) {
    throw new RunOperationalError(
      "The generated JSON did not match the supplied schema."
    );
  }
  return output;
}

async function executeSessionMode(
  { abortSignal, agent, client, now, stderr, stdout }: RunModeContext,
  options: RunCommandOptions & Extract<RunExecutionMode, { mode: "session" }>
): Promise<string> {
  const { sessionId } = options;
  await client.sessions.messages(agent.id, sessionId, { limit: 1 });
  const commonInput = {
    agentId: agent.id,
    metadata: options.metadata,
    sessionId,
    signal: abortSignal,
    userId: options.userId,
  };
  const result = await client.chat(
    options.kind === "stored"
      ? {
          ...commonInput,
          promptId: options.promptId,
          variables: options.variables,
        }
      : {
          ...commonInput,
          message: {
            id: randomUUID(),
            parts: [{ text: options.prompt, type: "text" }],
            role: "user" as const,
          },
        }
  );
  return consumeSessionStream({
    buffered: options.json,
    now,
    sessionId,
    stderr,
    stdout,
    stream: decodeUIMessageResponse(result.toResponse()),
    toolOutput: options.toolOutput,
  });
}

async function executeStatelessMode(
  { abortSignal, agent, client, promptInput, stdout }: RunModeContext,
  options: RunCommandOptions & Extract<RunExecutionMode, { mode: "stateless" }>
): Promise<string> {
  const result = await client.completion({
    agentId: agent.id,
    metadata: options.metadata,
    ...promptInput,
    signal: abortSignal,
    userId: options.userId,
  });
  let output = "";
  for await (const delta of result.textStream) {
    output += delta;
    if (!options.json) {
      stdout(delta);
    }
  }
  await result.text;
  return output;
}

export async function executeRun({
  agentSelector,
  apiKey,
  configuration,
  fetch,
  now = Date.now,
  onSignal,
  options,
  stderr,
  stdout,
}: {
  agentSelector: string;
  apiKey: string;
  configuration: ResolvedConfiguration;
  fetch?: BlazingAgentsOptions["fetch"];
  now?: () => number;
  onSignal?: (signal: RunSignal, listener: () => void) => () => void;
  options: RunCommandOptions;
  stderr: (text: string) => void;
  stdout: (text: string) => void;
}): Promise<number> {
  const abortController = new AbortController();
  let signalExitCode: 130 | 143 | undefined;
  const cleanups = (["SIGINT", "SIGTERM"] as const).map((signal) =>
    onSignal
      ? onSignal(signal, () => {
          signalExitCode = signal === "SIGINT" ? 130 : 143;
          abortController.abort(signal);
        })
      : () => undefined
  );

  try {
    const client = new BlazingAgents({
      apiKey,
      baseUrl: configuration.baseUrl,
      ...(fetch ? { fetch } : {}),
    });
    const { agents } = await client.agents.list();
    const agent = resolveAgent(agentSelector, agents);
    if (isAdminAgentId(agent.id)) {
      throw new RunOperationalError(
        "The Admin Agent is available only through BA Assist. Use ba assist instead."
      );
    }
    if (options.kind === "stored") {
      const prompt = await client.prompts.get(options.promptId);
      validatePromptVariables(prompt.variables, options.variables);
    }
    if (signalExitCode) {
      return signalExitCode;
    }

    const promptInput =
      options.kind === "stored"
        ? { promptId: options.promptId, variables: options.variables }
        : { prompt: options.prompt };
    const context = {
      abortSignal: abortController.signal,
      agent,
      client,
      now,
      promptInput,
      stderr,
      stdout,
    };
    let output: unknown;
    switch (options.mode) {
      case "schema":
        output = await executeSchemaMode(context, options);
        break;
      case "session":
        output = await executeSessionMode(context, options);
        break;
      case "stateless":
        output = await executeStatelessMode(context, options);
        break;
    }
    if (signalExitCode) {
      return signalExitCode;
    }
    if (options.mode === "schema" || options.json) {
      stdout(
        `${JSON.stringify({
          agent: { id: agent.id, name: agent.name },
          output,
          ...(options.mode === "session"
            ? { sessionId: options.sessionId }
            : {}),
        })}\n`
      );
    }
    return 0;
  } catch (error) {
    if (signalExitCode) {
      return signalExitCode;
    }
    throw error;
  } finally {
    for (const cleanup of cleanups) {
      cleanup();
    }
  }
}
