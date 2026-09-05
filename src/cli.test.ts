import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { executeCli } from "./cli.ts";
import {
  adminAgent,
  sessionId as adminSessionId,
} from "./test/approval-transport.ts";
import { createCredentialStoreFixture } from "./test/credential-store-fixture.ts";

const runAgent = {
  avatarUrl: null,
  createdAt: "2026-07-16T10:00:00.000Z",
  id: "ag_AAAAAAAAAAAAAAAA",
  instructions: "",
  mcpConnectionIds: [],
  memoryInjectionEnabled: false,
  metadata: {},
  model: "openrouter/test-model",
  name: "Release Agent",
  providerId: "prv_0123456789abcdef",
  thinkingLevel: null,
  workspaceId: "ws_AAAAAAAAAAAAAAAA",
  status: "active",
  tenantId: "ten_AAAAAAAAAAAAAAAA",
  tools: [],
  updatedAt: "2026-07-16T10:00:00.000Z",
  userId: "",
  version: 1,
};

function runFetch(agents = [runAgent]) {
  return (input: string) => {
    if (input.endsWith("/v1/agents")) {
      return Promise.resolve(Response.json({ agents }));
    }
    if (input.includes("/v1/prompts/")) {
      return Promise.resolve(
        Response.json({
          createdAt: "2026-07-16T10:00:00.000Z",
          id: "prompt_AAAAAAAAAAAAAAAA",
          metadata: {},
          name: "Release",
          template: "Release {{version}}",
          tenantId: "ten_AAAAAAAAAAAAAAAA",
          updatedAt: "2026-07-16T10:00:00.000Z",
          userId: "",
          variables: ["version"],
        })
      );
    }
    return Promise.resolve(new Response("generated"));
  };
}

async function captureCli(
  args: string[],
  runtime: Partial<Parameters<typeof executeCli>[1]> = {}
) {
  let stdout = "";
  let stderr = "";
  const exitCode = await executeCli(args, {
    stderr: (text) => {
      stderr += text;
    },
    stdout: (text) => {
      stdout += text;
    },
    version: "0.1.0",
    ...runtime,
  });
  return { exitCode, stderr, stdout };
}

test("running without a command shows the complete product help", async () => {
  let stdout = "";
  let stderr = "";

  const exitCode = await executeCli([], {
    stderr: (text) => {
      stderr += text;
    },
    stdout: (text) => {
      stdout += text;
    },
    version: "0.1.0",
  });

  expect({ exitCode, stderr, stdout }).toEqual({
    exitCode: 0,
    stderr: "",
    stdout: `Usage: ba [options] [command]

The Blazing Agents developer CLI

Options:
  -V, --version           output the version number
  --base-url <url>        override the Blazing Agents API base URL
  --login                 log in using the native credential store
  --logout                log out from the native credential store
  --status                show authentication status
  -h, --help              display help for command

Commands:
  assist [options]        administer Blazing Agents interactively
  chat [options] <agent>  chat with an Agent interactively
  run [options] <agent>   run one Agent turn
`,
  });
});

test("a command usage error prints relevant usage to stderr and exits 2", async () => {
  let stdout = "";
  let stderr = "";

  const exitCode = await executeCli(["chat", "Release Agent", "--unknown"], {
    stderr: (text) => {
      stderr += text;
    },
    stdout: (text) => {
      stdout += text;
    },
    version: "0.1.0",
  });

  expect({ exitCode, stderr, stdout }).toEqual({
    exitCode: 2,
    stderr: `error: unknown option '--unknown'

Usage: ba chat [options] <agent>

chat with an Agent interactively

Options:
  --session <id>  resume an existing Session
  -h, --help      display help for command
`,
    stdout: "",
  });
});

test("a credential action cannot be combined with a product command", async () => {
  const result = await captureCli(["--login", "chat", "Release Agent"]);

  expect(result).toEqual({
    exitCode: 2,
    stderr: `error: a credential action cannot be combined with a product command

Usage: ba [options] [command]

The Blazing Agents developer CLI

Options:
  -V, --version           output the version number
  --base-url <url>        override the Blazing Agents API base URL
  --login                 log in using the native credential store
  --logout                log out from the native credential store
  --status                show authentication status
  -h, --help              display help for command

Commands:
  assist [options]        administer Blazing Agents interactively
  chat [options] <agent>  chat with an Agent interactively
  run [options] <agent>   run one Agent turn
`,
    stdout: "",
  });
});

test("a credential action after a product command is also rejected", async () => {
  const result = await captureCli(["chat", "Release Agent", "--login"]);

  expect(result.exitCode).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(
    "error: a credential action cannot be combined with a product command"
  );
  expect(result.stderr).toContain("Usage: ba [options] [command]");
});

test("a malformed base URL is an invocation error", async () => {
  const result = await captureCli(["--base-url", "not-a-url"]);

  expect(result.exitCode).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(
    "Invalid base URL from --base-url; expected an HTTP(S) URL."
  );
  expect(result.stderr).toContain("Usage: ba [options] [command]");
});

test("help styling is enabled only for a TTY", async () => {
  let stdout = "";
  const exitCode = await executeCli(["--help"], {
    stderr: () => undefined,
    stderrIsTTY: true,
    stdout: (text) => {
      stdout += text;
    },
    stdoutIsTTY: true,
    version: "0.1.0",
  });

  expect(exitCode).toBe(0);
  expect(stdout).toContain("\u001B[");
});

test("a command rejects malformed YAML before behavior starts", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "ba-cli-config-"));
  const configDirectory = join(configHome, "blazing-agents");
  await mkdir(configDirectory);
  await writeFile(join(configDirectory, "config.yaml"), "apiKey: secret\n");
  let stdout = "";
  let stderr = "";

  try {
    const exitCode = await executeCli(["run", "Release Agent"], {
      environment: { XDG_CONFIG_HOME: configHome },
      platform: "linux",
      stderr: (text) => {
        stderr += text;
      },
      stdout: (text) => {
        stdout += text;
      },
      version: "0.1.0",
    });

    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("Invalid configuration at");
    expect(stderr).toContain("Usage: ba run [options] <agent>");
    expect(stderr).not.toContain("secret");
  } finally {
    await rm(configHome, { force: true, recursive: true });
  }
});

test("help and version bypass malformed configuration", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "ba-cli-config-"));
  const configDirectory = join(configHome, "blazing-agents");
  await mkdir(configDirectory);
  await writeFile(join(configDirectory, "config.yaml"), "baseUrl: [\n");

  try {
    for (const [args, expectedOutput] of [
      [["--help"], "Usage: ba [options] [command]"],
      [["chat", "--help"], "Usage: ba chat [options] <agent>"],
      [["--version"], "0.1.0\n"],
    ] as const) {
      let stdout = "";
      let stderr = "";
      const exitCode = await executeCli(args, {
        environment: { XDG_CONFIG_HOME: configHome },
        platform: "linux",
        stderr: (text) => {
          stderr += text;
        },
        stdout: (text) => {
          stdout += text;
        },
        version: "0.1.0",
      });

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain(expectedOutput);
    }
  } finally {
    await rm(configHome, { force: true, recursive: true });
  }
});

test("assist accepts valid local configuration and environment authentication", async () => {
  await expect(
    captureCli(["assist"], {
      environment: {
        BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}`,
      },
      fetch: runFetch([adminAgent]),
      loadTui: () => Promise.resolve({ runAgentTUI: () => Promise.resolve() }),
      stdinIsTTY: true,
      stdoutIsTTY: true,
    })
  ).resolves.toEqual({
    exitCode: 0,
    stderr: "",
    stdout: "",
  });
});

test("assist rejects non-TTY use before credentials, configuration, or API access", async () => {
  let credentialLoads = 0;
  let requests = 0;
  const result = await captureCli(["assist"], {
    environment: { CI: "true", XDG_CONFIG_HOME: "/not/read" },
    fetch: () => {
      requests += 1;
      throw new Error("the API must not be called");
    },
    loadCredentialStore: () => {
      credentialLoads += 1;
      throw new Error("the credential store must not load");
    },
    stdinIsTTY: true,
    stdoutIsTTY: false,
  });

  expect({ credentialLoads, requests, result }).toEqual({
    credentialLoads: 0,
    requests: 0,
    result: {
      exitCode: 1,
      stderr:
        "BA Assist requires an interactive terminal on stdin and stdout. Use ba run for non-interactive input.\n",
      stdout: "",
    },
  });
});

test("chat rejects non-TTY use before credentials, configuration, or API access", async () => {
  let credentialLoads = 0;
  let requests = 0;
  const result = await captureCli(["chat", "Release Agent"], {
    environment: { CI: "true", XDG_CONFIG_HOME: "/not/read" },
    fetch: () => {
      requests += 1;
      throw new Error("the API must not be called");
    },
    loadCredentialStore: () => {
      credentialLoads += 1;
      throw new Error("the credential store must not load");
    },
    stdinIsTTY: false,
    stdoutIsTTY: true,
  });

  expect({ credentialLoads, requests, result }).toEqual({
    credentialLoads: 0,
    requests: 0,
    result: {
      exitCode: 1,
      stderr:
        "Chat requires an interactive terminal on stdin and stdout. Use ba run for non-interactive input.\n",
      stdout: "",
    },
  });
});

test("chat resolves the Agent and lazily loads the upstream TUI only for an interactive command", async () => {
  let tuiLoads = 0;
  const result = await captureCli(["chat", "Release Agent"], {
    environment: { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` },
    fetch: runFetch(),
    loadTui: () => {
      tuiLoads += 1;
      return Promise.resolve({ runAgentTUI: () => Promise.resolve() });
    },
    stdinIsTTY: true,
    stdoutIsTTY: true,
  });

  expect({ result, tuiLoads }).toEqual({
    result: { exitCode: 0, stderr: "", stdout: "" },
    tuiLoads: 1,
  });
});

test("chat rejects a malformed Session id as command usage before credentials", async () => {
  const result = await captureCli(
    ["chat", "Release Agent", "--session", "not-a-session"],
    { stdinIsTTY: true, stdoutIsTTY: true }
  );

  expect(result.exitCode).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(
    "Invalid Session id; expected ss_ followed by 16 base62 characters."
  );
  expect(result.stderr).toContain("Usage: ba chat");
});

test("assist rejects a malformed Session id as command usage before credentials", async () => {
  const result = await captureCli(["assist", "--session", "not-a-session"], {
    stdinIsTTY: true,
    stdoutIsTTY: true,
  });

  expect(result.exitCode).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(
    "Invalid Session id; expected ss_ followed by 16 base62 characters."
  );
  expect(result.stderr).toContain("Usage: ba assist");
});

test("assist accepts and verifies a valid explicit Session id", async () => {
  const result = await captureCli(["assist", "--session", adminSessionId], {
    environment: { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` },
    fetch: (url) => {
      if (url.endsWith("/v1/agents")) {
        return Promise.resolve(Response.json({ agents: [adminAgent] }));
      }
      if (url.includes("/messages?limit=1")) {
        return Promise.resolve(
          Response.json({ data: [], latestCursor: null, nextCursor: null })
        );
      }
      return Promise.resolve(Response.json({ continuation: null, data: [] }));
    },
    loadTui: () => Promise.resolve({ runAgentTUI: () => Promise.resolve() }),
    stdinIsTTY: true,
    stdoutIsTTY: true,
  });
  expect(result).toEqual({
    exitCode: 0,
    stderr: "",
    stdout: `Session: ${adminSessionId}\nResume:  ba assist --session ${adminSessionId}\n`,
  });
});

test("chat accepts a valid explicit Session id and prints its resume receipt", async () => {
  const sessionId = "ss_AAAAAAAAAAAAAAAA";
  const result = await captureCli(
    ["chat", "Release Agent", "--session", sessionId],
    {
      environment: { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` },
      fetch: (url) =>
        Promise.resolve(
          url.endsWith("/v1/agents")
            ? Response.json({ agents: [runAgent] })
            : Response.json({
                data: [],
                latestCursor: null,
                nextCursor: null,
              })
        ),
      loadTui: () => Promise.resolve({ runAgentTUI: () => Promise.resolve() }),
      stdinIsTTY: true,
      stdoutIsTTY: true,
    }
  );

  expect(result).toEqual({
    exitCode: 0,
    stderr: "",
    stdout: `Agent:   Release Agent (${runAgent.id})
Session: ${sessionId}
Usage:   0 input + 0 output tokens
Resume:  ba chat ${runAgent.id} --session ${sessionId}
`,
  });
});

test("the run command parses stored Prompt and metadata options before executing", async () => {
  const result = await captureCli(
    [
      "run",
      "Release Agent",
      "--prompt-id",
      "prompt_AAAAAAAAAAAAAAAA",
      "--var",
      "version=1",
      "--metadata",
      '{"job":"release"}',
    ],
    {
      environment: { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` },
      fetch: runFetch(),
      stdinIsTTY: true,
    }
  );
  expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "generated" });
});

test.each([
  [
    "invalid variable",
    ["--prompt-id", "prompt_AAAAAAAAAAAAAAAA", "--var", "bad-name=1"],
  ],
  [
    "duplicate variable",
    [
      "--prompt-id",
      "prompt_AAAAAAAAAAAAAAAA",
      "--var",
      "version=1",
      "--var",
      "version=2",
    ],
  ],
  ["invalid metadata", ["--prompt", "hello", "--metadata", "[]"]],
  ["invalid Prompt id", ["--prompt-id", "not-a-prompt"]],
  ["invalid Session id", ["--prompt", "hello", "--session", "not-a-session"]],
  [
    "conflicting prompt sources",
    ["--prompt", "hello", "--prompt-id", "prompt_AAAAAAAAAAAAAAAA"],
  ],
  [
    "conflicting schema and Session options",
    [
      "--prompt",
      "hello",
      "--schema",
      "schema.json",
      "--session",
      "ss_AAAAAAAAAAAAAAAA",
    ],
  ],
] as const)(
  "the run command reports %s as Commander usage",
  async (_name, options) => {
    const result = await captureCli(["run", "Release Agent", ...options]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error:");
    expect(result.stderr).toContain("Usage: ba run");
  }
);

test("run reports syntax errors at the Commander boundary", async () => {
  const promptId = await captureCli([
    "run",
    "Release Agent",
    "--prompt-id",
    "not-a-prompt",
  ]);
  expect(promptId.stderr).toContain(
    "Invalid Prompt id; expected prompt_ followed by 16 base62 characters."
  );

  const conflicts = await captureCli([
    "run",
    "Release Agent",
    "--prompt",
    "hello",
    "--prompt-id",
    "prompt_AAAAAAAAAAAAAAAA",
  ]);
  expect(conflicts.stderr).toContain(
    "option '--prompt <text>' cannot be used with option '--prompt-id <id>'"
  );
});

test("run invocation and remote Prompt-variable errors include command usage", async () => {
  const missing = await captureCli(["run", "Release Agent"]);
  expect(missing.exitCode).toBe(2);
  expect(missing.stderr).toContain("Exactly one non-empty prompt source");

  const variables = await captureCli(
    ["run", "Release Agent", "--prompt-id", "prompt_AAAAAAAAAAAAAAAA"],
    {
      environment: { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` },
      fetch: runFetch(),
    }
  );
  expect(variables.exitCode).toBe(2);
  expect(variables.stderr).toContain("Invalid Prompt variables");
  expect(variables.stderr).toContain("Usage: ba run");
});

test("run reports operational, selection, and typed SDK failures safely", async () => {
  const environment = { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` };
  const admin = await captureCli(["run", "Admin Agent", "--prompt", "hello"], {
    environment,
    fetch: runFetch([adminAgent]),
  });
  expect(admin).toMatchObject({ exitCode: 1, stdout: "" });
  expect(admin.stderr).toContain("Use ba assist instead");

  const selection = await captureCli(
    ["run", "Missing Agent", "--prompt", "hello"],
    { environment, fetch: runFetch([]) }
  );
  expect(selection).toMatchObject({ exitCode: 1, stdout: "" });
  expect(selection.stderr).toContain("No Agent found");

  const sdk = await captureCli(
    ["run", "Release Agent", "--prompt", "hello", "--json"],
    {
      environment,
      fetch: () =>
        Promise.resolve(
          Response.json(
            {
              error: {
                code: "unauthorized",
                details: {
                  apiKey: "ba_do-not-print",
                  nested: { token: "also-do-not-print" },
                  retryAfter: 30,
                },
                message: "Invalid API key",
                param: "/apiKey",
              },
            },
            {
              headers: { "x-request-id": "req_0123456789abcdef" },
              status: 401,
            }
          )
        ),
    }
  );
  expect(sdk.exitCode).toBe(1);
  expect(sdk.stdout).toBe("");
  expect(sdk.stderr).toContain(
    "Invalid API key [code=unauthorized status=401 requestId=req_0123456789abcdef param=/apiKey"
  );
  expect(sdk.stderr).toContain('details={"apiKey":"[REDACTED]"');
  expect(sdk.stderr).toContain('"nested":{"token":"[REDACTED]"}');
  expect(sdk.stderr).toContain('"retryAfter":30');
  expect(sdk.stderr).not.toContain("ba_do-not-print");
  expect(sdk.stderr).not.toContain("also-do-not-print");

  const network = await captureCli(
    ["run", "Release Agent", "--prompt", "hello"],
    {
      environment,
      fetch: () => Promise.reject(new Error("Network request failed")),
    }
  );
  expect(network).toEqual({
    exitCode: 1,
    stderr: "Network request failed [code=network_error]\n",
    stdout: "",
  });
});

test("typed SDK diagnostics keep hostile scalar metadata single-line and bounded", async () => {
  const environment = { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` };
  const code = `future\ncode${"x".repeat(300)}`;
  const requestId = `req-${"r".repeat(300)}`;
  const param = `/prompt\nparam${"p".repeat(300)}`;
  const result = await captureCli(
    ["run", "Release Agent", "--prompt", "hello", "--json"],
    {
      environment,
      fetch: () =>
        Promise.resolve(
          Response.json(
            {
              error: {
                code,
                message: "Hostile metadata",
                param,
              },
            },
            { headers: { "x-request-id": requestId }, status: 500 }
          )
        ),
    }
  );

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
  expect(result.stderr).toContain("Hostile metadata [code=future code");
  expect(result.stderr).toContain("requestId=req-");
  expect(result.stderr).toContain("param=/prompt param");
  expect(result.stderr.length).toBeLessThan(600);
  expect(result.stderr).not.toContain("x".repeat(300));
  expect(result.stderr).not.toContain("r".repeat(300));
  expect(result.stderr).not.toContain("p".repeat(300));
});

test("TTY usage errors are styled only on stderr", async () => {
  let stdout = "";
  let stderr = "";
  const exitCode = await executeCli(["--unknown"], {
    stderr: (text) => {
      stderr += text;
    },
    stderrIsTTY: true,
    stdout: (text) => {
      stdout += text;
    },
    stdoutIsTTY: false,
    version: "0.1.0",
  });

  expect(exitCode).toBe(2);
  expect(stdout).toBe("");
  expect(stderr).toContain("\u001B[");
});

test("unexpected process output failures are not hidden", async () => {
  const failure = new Error("stdout unavailable");

  await expect(
    executeCli([], {
      stderr: () => undefined,
      stdout: () => {
        throw failure;
      },
      version: "0.1.0",
    })
  ).rejects.toBe(failure);
});

test("login without an interactive secret reader fails safely before native loading", async () => {
  const result = await captureCli(["--login"], { stdinIsTTY: true });

  expect(result).toEqual({
    exitCode: 1,
    stderr: "Login requires an interactive terminal.\n",
    stdout: "",
  });
});

test("CI without an environment API key fails before native loading or prompting", async () => {
  let nativeLoads = 0;
  let prompts = 0;
  let stdout = "";
  let stderr = "";

  const exitCode = await executeCli(
    ["run", "Release Agent", "--prompt", "hello"],
    {
      environment: { CI: "true" },
      loadCredentialStore: () => {
        nativeLoads += 1;
        throw new Error("native store must not load");
      },
      readSecret: () => {
        prompts += 1;
        return Promise.resolve("dashboard-secret");
      },
      stderr: (text) => {
        stderr += text;
      },
      stdout: (text) => {
        stdout += text;
      },
      version: "0.1.0",
    }
  );

  expect({ exitCode, nativeLoads, prompts, stderr, stdout }).toEqual({
    exitCode: 1,
    nativeLoads: 0,
    prompts: 0,
    stderr: "Authentication is required in CI. Set BLAZING_AGENTS_API_KEY.\n",
    stdout: "",
  });
});

test("status validates an environment override without loading or persisting native credentials", async () => {
  const credentialStore = createCredentialStoreFixture();
  const token = `ba_${"e".repeat(40)}`;
  const authorizations: string[] = [];
  let stdout = "";
  let stderr = "";

  const exitCode = await executeCli(["--status"], {
    environment: { BLAZING_AGENTS_API_KEY: token },
    fetch: (_input, init) => {
      authorizations.push(
        new Headers(init?.headers).get("authorization") ?? ""
      );
      return Promise.resolve(
        Response.json(
          {
            name: "Tenant",
            quota: null,
          },
          { status: 200 }
        )
      );
    },
    loadCredentialStore: credentialStore.loader,
    stderr: (text) => {
      stderr += text;
    },
    stdout: (text) => {
      stdout += text;
    },
    version: "0.1.0",
  });

  expect({
    authorizations,
    exitCode,
    nativeLoads: credentialStore.loadCount,
    stderr,
    storedEntries: credentialStore.entries.size,
    stdout,
  }).toEqual({
    authorizations: [`Bearer ${token}`],
    exitCode: 0,
    nativeLoads: 0,
    stderr: "",
    storedEntries: 0,
    stdout: `API origin: https://api.blazingagents.com
Configuration source: default
Credential source: environment (BLAZING_AGENTS_API_KEY)
Remote validity: valid
`,
  });
});
