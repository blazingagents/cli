import type { BlazingAgentsOptions } from "@blazingagents/sdk";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { expect, test, vi } from "vitest";
import { executeAssist } from "./assist.ts";
import {
  adminAgent,
  adminAgentId,
  approvalDecision,
  approvalList,
  jsonSse,
  sessionId,
} from "./test/approval-transport.ts";

vi.mock("@ai-sdk/tui", () => ({
  runAgentTUI: vi.fn(() => Promise.resolve()),
}));

test("an explicit Admin Session recovers pending approvals before a clean TUI", async () => {
  const requests: Array<{ body: unknown; method: string; url: string }> = [];
  const events: string[] = [];
  const prompts: string[] = [];
  const fetch: NonNullable<BlazingAgentsOptions["fetch"]> = (url, init) => {
    requests.push({
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      method: init?.method ?? "GET",
      url,
    });
    if (url.endsWith("/v1/agents")) {
      return Promise.resolve(Response.json({ agents: [adminAgent] }));
    }
    if (url.endsWith(`/sessions/${sessionId}/messages?limit=1`)) {
      return Promise.resolve(
        Response.json({ data: [], latestCursor: null, nextCursor: null })
      );
    }
    if (url.endsWith(`/sessions/${sessionId}/tool-approvals`)) {
      const decided = requests.filter(
        ({ method, url: requestUrl }) =>
          method === "POST" && requestUrl.includes("/tool-approvals/")
      ).length;
      return approvalList({
        continuation: null,
        data: [
          {
            approvalId: "approval-update",
            decision: decided >= 1 ? "approved" : "pending",
            input: {
              action: "updateById",
              agentId: "ag_BBBBBBBBBBBBBBBB",
              changes: { name: "Approved name" },
            },
            reason: null,
            toolCallId: "call-update",
            toolName: "agents",
          },
          {
            approvalId: "approval-delete",
            decision: decided >= 2 ? "denied" : "pending",
            input: {
              action: "deleteById",
              agentId: "ag_CCCCCCCCCCCCCCCC",
            },
            reason: null,
            toolCallId: "call-delete",
            toolName: "agents",
          },
        ],
      });
    }
    if (url.includes("/tool-approvals/")) {
      return approvalDecision({
        continuationId: "continuation-recovery",
        state: url.endsWith("approval-update") ? "waiting" : "queued",
      });
    }
    if (url.endsWith("/tool-approval-continuations/continuation-recovery")) {
      return Promise.resolve(
        jsonSse([
          { type: "start", messageId: "assistant-pending" },
          {
            type: "tool-input-available",
            toolCallId: "call-update",
            toolName: "agents",
            input: { action: "updateById" },
          },
          {
            type: "tool-output-available",
            toolCallId: "call-update",
            output: { name: "Approved name" },
          },
          { type: "text-start", id: "text-recovery" },
          {
            type: "text-delta",
            id: "text-recovery",
            delta: "Recovery settled.",
          },
          { type: "text-end", id: "text-recovery" },
          { type: "finish", finishReason: "stop" },
        ])
      );
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const runAgentTUI = vi.fn(() => {
    events.push("tui");
    return Promise.resolve();
  });

  await executeAssist({
    apiKey: "ba_test",
    configuration: { baseUrl: "https://api.example.com", source: "flag" },
    fetch,
    loadTui: () => Promise.resolve({ runAgentTUI }),
    readApproval: (prompt) => {
      prompts.push(prompt);
      return Promise.resolve(prompts.length === 1);
    },
    sessionId,
    stdout: (text) => {
      events.push(text);
    },
  });

  expect(prompts).toHaveLength(2);
  expect(prompts[0]).toContain("Tool: agents");
  expect(prompts[0]).toContain('"action": "updateById"');
  expect(prompts[0]).toContain('"name": "Approved name"');
  expect(prompts[1]).toContain('"action": "deleteById"');
  expect(
    requests.filter(({ url }) => url.includes("/tool-approvals/"))
  ).toEqual([
    expect.objectContaining({ body: { approved: true }, method: "POST" }),
    expect.objectContaining({ body: { approved: false }, method: "POST" }),
  ]);
  expect(events.join("")).toContain(
    'Tool agents succeeded: {"name":"Approved name"}'
  );
  expect(events.join("")).toContain("Recovery settled.");
  expect(events.indexOf("tui")).toBeGreaterThan(
    events.findIndex((event) => event.includes("Recovery settled."))
  );
  expect(runAgentTUI).toHaveBeenCalledWith({
    responseStatistics: "outputTokenCount",
    title: "BA Assist",
    transport: expect.anything(),
  });
  expect(events.join("")).toContain(`Session: ${sessionId}\n`);
  expect(events.join("")).toContain(
    `Resume:  ba assist --session ${sessionId}\n`
  );
});

test("a new Assist interaction creates its Session only on the first submitted prompt", async () => {
  const requests: Array<{ method: string; url: string }> = [];
  let stdout = "";
  const fetch: NonNullable<BlazingAgentsOptions["fetch"]> = (url, init) => {
    requests.push({ method: init?.method ?? "GET", url });
    if (url.endsWith("/v1/agents")) {
      return Promise.resolve(Response.json({ agents: [adminAgent] }));
    }
    if (url.endsWith(`/v1/agents/${adminAgentId}/sessions`)) {
      return Promise.resolve(
        new Response(
          [
            { type: "start", messageId: "assistant-new" },
            { type: "text-start", id: "text-new" },
            { type: "text-delta", id: "text-new", delta: "Ready." },
            { type: "text-end", id: "text-new" },
            {
              type: "finish",
              finishReason: "stop",
              messageMetadata: {
                blazingAgents: {
                  usage: {
                    agentId: adminAgentId,
                    commitId: "commit-assist",
                    completedAt: "2026-07-16T10:00:01.000Z",
                    durationMs: 1000,
                    errorMessage: null,
                    inputTokens: 5,
                    modelDurationMs: 250,
                    metadata: {},
                    modelId: adminAgent.model,
                    outputTokens: 2,
                    requestId: "request-assist",
                    sessionId,
                    startedAt: "2026-07-16T10:00:00.000Z",
                    status: "succeeded",
                    stepUsages: [],
                    tenantId: adminAgent.tenantId,
                    userId: "",
                  },
                },
              },
            },
          ]
            .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
            .concat("data: [DONE]\n\n")
            .join(""),
          {
            headers: {
              "content-type": "text/event-stream",
              location: `/v1/agents/${adminAgentId}/sessions/${sessionId}`,
            },
            status: 201,
          }
        )
      );
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  await executeAssist({
    apiKey: "ba_test",
    configuration: { baseUrl: "https://api.example.com", source: "flag" },
    fetch,
    loadTui: () =>
      Promise.resolve({
        runAgentTUI: async ({ transport }) => {
          const user: UIMessage = {
            id: "user-new",
            parts: [{ text: "Inspect tenant settings", type: "text" }],
            role: "user",
          };
          const chunks: UIMessageChunk[] = [];
          for await (const chunk of await (
            transport as ChatTransport<UIMessage>
          ).sendMessages({
            abortSignal: undefined,
            chatId: "tui-id",
            messageId: undefined,
            messages: [user],
            trigger: "submit-message",
          })) {
            chunks.push(chunk);
          }
          expect(chunks).toContainEqual({
            type: "text-delta",
            id: "text-new",
            delta: "Ready.",
          });
        },
      }),
    stdout: (text) => {
      stdout += text;
    },
  });

  expect(requests).toEqual([
    { method: "GET", url: "https://api.example.com/v1/agents" },
    {
      method: "POST",
      url: `https://api.example.com/v1/agents/${adminAgentId}/sessions`,
    },
  ]);
  expect(stdout).toContain(`Session: ${sessionId}\n`);
  expect(stdout).toContain(`Resume:  ba assist --session ${sessionId}\n`);
});

test.each([
  ["no", [], "found 0"],
  ["multiple", [adminAgent, { ...adminAgent }], "found 2"],
] as const)(
  "%s visible Admin Agents is a fatal platform invariant failure",
  async (_name, agents, message) => {
    let tuiLoads = 0;
    await expect(
      executeAssist({
        apiKey: "ba_test",
        configuration: {
          baseUrl: "https://api.example.com",
          source: "flag",
        },
        fetch: () => Promise.resolve(Response.json({ agents })),
        loadTui: () => {
          tuiLoads += 1;
          return Promise.resolve({ runAgentTUI: () => Promise.resolve() });
        },
        stdout: () => undefined,
      })
    ).rejects.toThrow(message);
    expect(tuiLoads).toBe(0);
  }
);

test("an unconfigured Admin Agent directs the Tenant to configure a Provider and model", async () => {
  let tuiLoads = 0;

  await expect(
    executeAssist({
      apiKey: "ba_test",
      configuration: {
        baseUrl: "https://api.example.com",
        source: "flag",
      },
      fetch: () =>
        Promise.resolve(
          Response.json({
            agents: [{ ...adminAgent, model: null, providerId: null }],
          })
        ),
      loadTui: () => {
        tuiLoads += 1;
        return Promise.resolve({ runAgentTUI: () => Promise.resolve() });
      },
      stdout: () => undefined,
    })
  ).rejects.toThrow(
    "BA Assist needs an Admin Agent Provider and model. Add a Provider in the dashboard, then select its model on the Admin Agent."
  );
  expect(tuiLoads).toBe(0);
});

test.each([false, true])(
  "a live pre-stream failure restores an Assist terminal with TTY=%s",
  async (isTTY) => {
    const failure = new Error("typed Assist pre-stream failure");
    const pause = vi.fn();
    const setRawMode = vi.fn();
    let stdout = "";

    await expect(
      executeAssist({
        apiKey: "ba_test",
        configuration: {
          baseUrl: "https://api.example.com",
          source: "flag",
        },
        fetch: () => Promise.resolve(Response.json({ agents: [adminAgent] })),
        loadTui: () =>
          Promise.resolve({ runAgentTUI: () => Promise.reject(failure) }),
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

test("a TUI failure still prints an existing Session receipt", async () => {
  const failure = new Error("typed Assist pre-stream failure");
  let stdout = "";
  await expect(
    executeAssist({
      apiKey: "ba_test",
      configuration: { baseUrl: "https://api.example.com", source: "flag" },
      fetch: (url) => {
        if (url.endsWith("/v1/agents")) {
          return Promise.resolve(Response.json({ agents: [adminAgent] }));
        }
        if (url.endsWith("/messages?limit=1")) {
          return Promise.resolve(
            Response.json({ data: [], latestCursor: null, nextCursor: null })
          );
        }
        return approvalList({ continuation: null, data: [] });
      },
      loadTui: () =>
        Promise.resolve({ runAgentTUI: () => Promise.reject(failure) }),
      sessionId,
      stdout: (text) => {
        stdout += text;
      },
      terminal: { isTTY: false, pause: vi.fn(), setRawMode: vi.fn() },
    })
  ).rejects.toBe(failure);
  expect(stdout).toBe(
    `\u001B[?25h\u001B[?1049lSession: ${sessionId}\nResume:  ba assist --session ${sessionId}\n`
  );
});

test("the default lazy loader imports the published upstream TUI", async () => {
  await expect(
    executeAssist({
      apiKey: "ba_test",
      configuration: { baseUrl: "https://api.example.com", source: "flag" },
      fetch: () => Promise.resolve(Response.json({ agents: [adminAgent] })),
      stdout: () => undefined,
    })
  ).resolves.toBeUndefined();
  const { runAgentTUI } = await import("@ai-sdk/tui");
  expect(runAgentTUI).toHaveBeenCalledWith(
    expect.objectContaining({ title: "BA Assist" })
  );
});
