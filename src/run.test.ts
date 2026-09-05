import type { BlazingAgentsOptions } from "@blazingagents/sdk";
import { expect, test, vi } from "vitest";
import { executeRun, type RunSignal } from "./run.ts";
import type { RunCommandOptions, RunExecutionMode } from "./run-input.ts";
import { RunOperationalError } from "./run-output.ts";

const agentId = "ag_AAAAAAAAAAAAAAAA";
const promptId = "prompt_AAAAAAAAAAAAAAAA";
const sessionId = "ss_AAAAAAAAAAAAAAAA";
const agent = {
  avatarUrl: null,
  createdAt: "2026-07-16T10:00:00.000Z",
  id: agentId,
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

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function sse(chunks: unknown[]) {
  return new Response(
    chunks
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
      .concat("data: [DONE]\n\n")
      .join(""),
    { headers: { "content-type": "text/event-stream" } }
  );
}

function createFetch({
  generation = "generated",
  promptVariables = ["version"],
  sessionChunks = [
    { type: "text-delta", id: "text", delta: "session output" },
    { type: "finish", finishReason: "stop" },
  ],
}: {
  generation?: string;
  promptVariables?: string[];
  sessionChunks?: unknown[];
} = {}) {
  const calls: Array<{ body: unknown; url: string }> = [];
  // biome-ignore lint/suspicious/useAwait: synchronous boundary fixture implements the SDK fetch contract
  const fetch: NonNullable<BlazingAgentsOptions["fetch"]> = async (
    url,
    init
  ) => {
    calls.push({
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      url,
    });
    if (url.endsWith("/v1/agents")) {
      return json({ agents: [agent] });
    }
    if (url.endsWith(`/v1/prompts/${promptId}`)) {
      return json({
        createdAt: "2026-07-16T10:00:00.000Z",
        id: promptId,
        metadata: {},
        name: "Release",
        template: "Release {{version}}",
        tenantId: "ten_AAAAAAAAAAAAAAAA",
        updatedAt: "2026-07-16T10:00:00.000Z",
        userId: "",
        variables: promptVariables,
      });
    }
    if (url.includes("/messages?limit=1")) {
      return json({ data: [], latestCursor: null, nextCursor: null });
    }
    if (url.endsWith(`/sessions/${sessionId}`)) {
      return sse(sessionChunks);
    }
    if (url.endsWith("/generation")) {
      return new Response(generation, {
        headers: { "content-type": "text/plain" },
      });
    }
    return json({ error: { code: "not_found", message: "Not found" } }, 404);
  };
  return { calls, fetch };
}

function literalOptions(
  mode: RunExecutionMode = { json: false, mode: "stateless" }
): RunCommandOptions {
  return {
    kind: "literal",
    metadata: {},
    ...mode,
    prompt: "hello",
    toolOutput: "summary",
    userId: "",
  };
}

async function run(
  options: RunCommandOptions,
  overrides: Partial<Parameters<typeof executeRun>[0]> = {}
) {
  let stdout = "";
  let stderr = "";
  const fixture = createFetch();
  const exitCode = await executeRun({
    agentSelector: "Release Agent",
    apiKey: "ba_test",
    configuration: { baseUrl: "https://api.example.com", source: "flag" },
    fetch: fixture.fetch,
    options,
    stderr: (text) => {
      stderr += text;
    },
    stdout: (text) => {
      stdout += text;
    },
    ...overrides,
  });
  return { calls: fixture.calls, exitCode, stderr, stdout };
}

test("stateless modes stream plain text or emit one JSON document", async () => {
  const plain = await run(literalOptions());
  expect(plain.exitCode).toBe(0);
  expect(plain.stdout).toBe("generated");
  expect(plain.stderr).toBe("");

  const buffered = await run(literalOptions({ json: true, mode: "stateless" }));
  expect(buffered.stdout).toBe(
    `{"agent":{"id":"${agentId}","name":"Release Agent"},"output":"generated"}\n`
  );
  expect(buffered.calls.at(-1)?.body).toMatchObject({
    metadata: {},
    prompt: "hello",
    userId: "",
  });
});

test("stored Prompt execution validates variables before stateless generation", async () => {
  const fixture = createFetch();
  let stdout = "";
  const exitCode = await executeRun({
    agentSelector: "Release Agent",
    apiKey: "ba_test",
    configuration: { baseUrl: "https://api.example.com", source: "flag" },
    fetch: fixture.fetch,
    options: {
      json: false,
      kind: "stored",
      metadata: { job: "release" },
      mode: "stateless",
      promptId,
      toolOutput: "summary",
      userId: "developer",
      variables: { version: "1" },
    },
    stderr: () => undefined,
    stdout: (text) => {
      stdout += text;
    },
  });
  expect(exitCode).toBe(0);
  expect(stdout).toBe("generated");
  expect(fixture.calls.at(-1)?.body).toMatchObject({
    metadata: { job: "release" },
    promptId,
    userId: "developer",
    variables: { version: "1" },
  });

  await expect(
    executeRun({
      agentSelector: "Release Agent",
      apiKey: "ba_test",
      configuration: { baseUrl: "https://api.example.com", source: "flag" },
      fetch: createFetch().fetch,
      options: {
        json: false,
        kind: "stored",
        metadata: {},
        mode: "stateless",
        promptId,
        toolOutput: "summary",
        userId: "",
        variables: {},
      },
      stderr: () => undefined,
      stdout: () => undefined,
    })
  ).rejects.toThrow("missing: version");
});

test("schema mode validates generated JSON before emitting it", async () => {
  const schema = {
    additionalProperties: false,
    properties: { answer: { type: "number" as const } },
    required: ["answer"],
    type: "object" as const,
  };
  const successFixture = createFetch({ generation: '{"answer":42}' });
  let stdout = "";
  await expect(
    executeRun({
      agentSelector: "Release Agent",
      apiKey: "ba_test",
      configuration: { baseUrl: "https://api.example.com", source: "flag" },
      fetch: successFixture.fetch,
      options: literalOptions({ mode: "schema", schema }),
      stderr: () => undefined,
      stdout: (text) => {
        stdout += text;
      },
    })
  ).resolves.toBe(0);
  expect(stdout).toContain('"output":{"answer":42}');

  await expect(
    executeRun({
      agentSelector: "Release Agent",
      apiKey: "ba_test",
      configuration: { baseUrl: "https://api.example.com", source: "flag" },
      fetch: createFetch({ generation: '{"answer":"wrong"}' }).fetch,
      options: literalOptions({ mode: "schema", schema }),
      stderr: () => undefined,
      stdout: () => undefined,
    })
  ).rejects.toEqual(
    new RunOperationalError(
      "The generated JSON did not match the supplied schema."
    )
  );
});

test("explicit Session mode verifies then resumes literal and stored prompts", async () => {
  const literal = await run(
    literalOptions({ json: true, mode: "session", sessionId })
  );
  expect(literal.stdout).toContain(`"sessionId":"${sessionId}"`);
  expect(literal.calls.map(({ url }) => url)).toEqual([
    "https://api.example.com/v1/agents",
    `https://api.example.com/v1/agents/${agentId}/sessions/${sessionId}/messages?limit=1`,
    `https://api.example.com/v1/agents/${agentId}/sessions/${sessionId}`,
  ]);

  const fixture = createFetch();
  await expect(
    executeRun({
      agentSelector: "Release Agent",
      apiKey: "ba_test",
      configuration: { baseUrl: "https://api.example.com", source: "flag" },
      fetch: fixture.fetch,
      options: {
        json: false,
        kind: "stored",
        metadata: {},
        mode: "session",
        promptId,
        sessionId,
        toolOutput: "off",
        userId: "",
        variables: { version: "1" },
      },
      stderr: () => undefined,
      stdout: () => undefined,
    })
  ).resolves.toBe(0);
  expect(fixture.calls.at(-1)?.body).toMatchObject({ promptId });
});

test("Admin Agent selection is an operational failure", async () => {
  const fetch: NonNullable<BlazingAgentsOptions["fetch"]> = () =>
    Promise.resolve(
      json({
        agents: [{ ...agent, id: "ag_admAAAAAAAAAAAAA", name: "Admin Agent" }],
      })
    );
  await expect(
    executeRun({
      agentSelector: "Admin Agent",
      apiKey: "ba_test",
      configuration: { baseUrl: "https://api.example.com", source: "flag" },
      fetch,
      options: literalOptions(),
      stderr: () => undefined,
      stdout: () => undefined,
    })
  ).rejects.toThrow("Use ba assist instead");
});

test.each([
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const)(
  "signals abort an active SDK request and clean up handlers",
  async (signal, code) => {
    const listeners = new Map<RunSignal, () => void>();
    const cleaned: RunSignal[] = [];
    // biome-ignore lint/suspicious/useAwait: synchronous boundary fixture implements the SDK fetch contract
    const fetch: NonNullable<BlazingAgentsOptions["fetch"]> = async (url) => {
      if (url.endsWith("/v1/agents")) {
        return json({ agents: [agent] });
      }
      listeners.get(signal)?.();
      throw new Error("aborted transport");
    };
    await expect(
      executeRun({
        agentSelector: "Release Agent",
        apiKey: "ba_test",
        configuration: { baseUrl: "https://api.example.com", source: "flag" },
        fetch,
        onSignal: (registered, listener) => {
          listeners.set(registered, listener);
          return () => cleaned.push(registered);
        },
        options: literalOptions(),
        stderr: () => undefined,
        stdout: () => undefined,
      })
    ).resolves.toBe(code);
    expect(cleaned).toEqual(["SIGINT", "SIGTERM"]);
  }
);

test("a signal observed after Prompt validation exits before a Turn", async () => {
  const listeners = new Map<RunSignal, () => void>();
  const fixture = createFetch();
  const fetch: NonNullable<BlazingAgentsOptions["fetch"]> = async (
    url,
    init
  ) => {
    const response = await fixture.fetch(url, init);
    if (url.includes("/prompts/")) {
      listeners.get("SIGTERM")?.();
    }
    return response;
  };
  await expect(
    executeRun({
      agentSelector: "Release Agent",
      apiKey: "ba_test",
      configuration: { baseUrl: "https://api.example.com", source: "flag" },
      fetch,
      onSignal: (signal, listener) => {
        listeners.set(signal, listener);
        return () => undefined;
      },
      options: {
        json: false,
        kind: "stored",
        metadata: {},
        mode: "stateless",
        promptId,
        toolOutput: "summary",
        userId: "",
        variables: { version: "1" },
      },
      stderr: () => undefined,
      stdout: () => undefined,
    })
  ).resolves.toBe(143);
  expect(fixture.calls.some(({ url }) => url.endsWith("/generation"))).toBe(
    false
  );
});

test("a signal observed while a successful body settles suppresses buffered output", async () => {
  const listeners = new Map<RunSignal, () => void>();
  const fixture = createFetch();
  // biome-ignore lint/suspicious/useAwait: synchronous boundary fixture implements the SDK fetch contract
  const fetch: NonNullable<BlazingAgentsOptions["fetch"]> = async (
    url,
    init
  ) => {
    if (url.endsWith("/generation")) {
      listeners.get("SIGINT")?.();
    }
    return fixture.fetch(url, init);
  };
  let stdout = "";
  await expect(
    executeRun({
      agentSelector: "Release Agent",
      apiKey: "ba_test",
      configuration: { baseUrl: "https://api.example.com", source: "flag" },
      fetch,
      onSignal: (signal, listener) => {
        listeners.set(signal, listener);
        return () => undefined;
      },
      options: literalOptions({ json: true, mode: "stateless" }),
      stderr: () => undefined,
      stdout: (text) => {
        stdout += text;
      },
    })
  ).resolves.toBe(130);
  expect(stdout).toBe("");
});

test("execution uses the SDK default fetch when no override is supplied", async () => {
  const fixture = createFetch();
  vi.stubGlobal("fetch", fixture.fetch);
  try {
    await expect(
      executeRun({
        agentSelector: "Release Agent",
        apiKey: "ba_test",
        configuration: { baseUrl: "https://api.example.com", source: "flag" },
        options: literalOptions(),
        stderr: () => undefined,
        stdout: () => undefined,
      })
    ).resolves.toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});
