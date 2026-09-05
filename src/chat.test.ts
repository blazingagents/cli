import type { Agent, BlazingAgentsOptions } from "@blazingagents/sdk";
import { expect, test, vi } from "vitest";
import { executeChat } from "./chat.ts";

const agentId = "ag_AAAAAAAAAAAAAAAA";
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
} satisfies Agent;

vi.mock("@ai-sdk/tui", () => ({
  runAgentTUI: vi.fn(() => Promise.resolve()),
}));

test("opening and exiting a new chat creates no Session and prints no receipt", async () => {
  const urls: string[] = [];
  // biome-ignore lint/suspicious/useAwait: synchronous fixture implements the SDK fetch contract
  const fetch: NonNullable<BlazingAgentsOptions["fetch"]> = async (url) => {
    urls.push(url);
    return Response.json({ agents: [agent] });
  };
  const runAgentTUI = vi.fn().mockResolvedValue(undefined);
  let stdout = "";

  await executeChat({
    agentSelector: "Release Agent",
    apiKey: "ba_test",
    configuration: { baseUrl: "https://api.example.com", source: "flag" },
    fetch,
    loadTui: () => Promise.resolve({ runAgentTUI }),
    stdout: (text) => {
      stdout += text;
    },
  });

  expect(urls).toEqual(["https://api.example.com/v1/agents"]);
  expect(stdout).toBe("");
  expect(runAgentTUI).toHaveBeenCalledWith({
    responseStatistics: "outputTokenCount",
    title: "BA Chat · Release Agent",
    transport: expect.anything(),
  });
});

test("an explicit Session is verified before the TUI and prints an exact receipt", async () => {
  const sessionId = "ss_AAAAAAAAAAAAAAAA";
  const urls: string[] = [];
  // biome-ignore lint/suspicious/useAwait: synchronous fixture implements the SDK fetch contract
  const fetch: NonNullable<BlazingAgentsOptions["fetch"]> = async (url) => {
    urls.push(url);
    if (url.endsWith("/v1/agents")) {
      return Response.json({ agents: [agent] });
    }
    return Response.json({ data: [], latestCursor: null, nextCursor: null });
  };
  let stdout = "";

  await executeChat({
    agentSelector: agentId,
    apiKey: "ba_test",
    configuration: { baseUrl: "https://api.example.com", source: "flag" },
    fetch,
    loadTui: () => Promise.resolve({ runAgentTUI: () => Promise.resolve() }),
    sessionId,
    stdout: (text) => {
      stdout += text;
    },
  });

  expect(urls).toEqual([
    "https://api.example.com/v1/agents",
    `https://api.example.com/v1/agents/${agentId}/sessions/${sessionId}/messages?limit=1`,
  ]);
  expect(stdout).toBe(`Agent:   Release Agent (${agentId})
Session: ${sessionId}
Usage:   0 input + 0 output tokens
Resume:  ba chat ${agentId} --session ${sessionId}
`);
});

test("a missing or foreign Session fails before the TUI without fallback", async () => {
  const sessionId = "ss_AAAAAAAAAAAAAAAA";
  const urls: string[] = [];
  let tuiLoads = 0;
  // biome-ignore lint/suspicious/useAwait: synchronous fixture implements the SDK fetch contract
  const fetch: NonNullable<BlazingAgentsOptions["fetch"]> = async (url) => {
    urls.push(url);
    if (url.endsWith("/v1/agents")) {
      return Response.json({ agents: [agent] });
    }
    return Response.json(
      { error: { code: "not_found", message: "Session not found" } },
      { status: 404 }
    );
  };

  await expect(
    executeChat({
      agentSelector: "Release Agent",
      apiKey: "ba_test",
      configuration: { baseUrl: "https://api.example.com", source: "flag" },
      fetch,
      loadTui: () => {
        tuiLoads += 1;
        return Promise.resolve({ runAgentTUI: () => Promise.resolve() });
      },
      sessionId,
      stdout: () => undefined,
    })
  ).rejects.toThrow("Session not found");
  expect(tuiLoads).toBe(0);
  expect(urls).toEqual([
    "https://api.example.com/v1/agents",
    `https://api.example.com/v1/agents/${agentId}/sessions/${sessionId}/messages?limit=1`,
  ]);
});

test("the Admin Agent is rejected before the TUI with BA Assist guidance", async () => {
  let tuiLoads = 0;
  await expect(
    executeChat({
      agentSelector: "Admin Agent",
      apiKey: "ba_test",
      configuration: { baseUrl: "https://api.example.com", source: "flag" },
      fetch: () =>
        Promise.resolve(
          Response.json({
            agents: [
              { ...agent, id: "ag_admAAAAAAAAAAAAA", name: "Admin Agent" },
            ],
          })
        ),
      loadTui: () => {
        tuiLoads += 1;
        return Promise.resolve({ runAgentTUI: () => Promise.resolve() });
      },
      stdout: () => undefined,
    })
  ).rejects.toThrow("Use ba assist instead");
  expect(tuiLoads).toBe(0);
});

test("the default lazy loader imports the published upstream TUI", async () => {
  await expect(
    executeChat({
      agentSelector: "Release Agent",
      apiKey: "ba_test",
      configuration: { baseUrl: "https://api.example.com", source: "flag" },
      fetch: () => Promise.resolve(Response.json({ agents: [agent] })),
      stdout: () => undefined,
    })
  ).resolves.toBeUndefined();
  const { runAgentTUI } = await import("@ai-sdk/tui");
  expect(runAgentTUI).toHaveBeenCalledWith(
    expect.objectContaining({ responseStatistics: "outputTokenCount" })
  );
});

test.each([false, true])(
  "a pre-stream TUI rejection restores a terminal with TTY=%s",
  async (isTTY) => {
    const failure = new Error("typed pre-stream failure");
    const pause = vi.fn();
    const setRawMode = vi.fn();
    let stdout = "";

    await expect(
      executeChat({
        agentSelector: "Release Agent",
        apiKey: "ba_test",
        configuration: {
          baseUrl: "https://api.example.com",
          source: "flag",
        },
        fetch: () => Promise.resolve(Response.json({ agents: [agent] })),
        loadTui: () =>
          Promise.resolve({
            runAgentTUI: () => Promise.reject(failure),
          }),
        stdout: (text) => {
          stdout += text;
        },
        terminal: { isTTY, pause, setRawMode },
      })
    ).rejects.toBe(failure);
    expect(stdout).toBe("\u001B[?25h\u001B[?1049l");
    expect(setRawMode).toHaveBeenCalledTimes(isTTY ? 1 : 0);
    expect(pause).toHaveBeenCalledTimes(isTTY ? 1 : 0);
  }
);
