import type { BlazingAgentsOptions } from "@blazingagents/sdk";
import { expect, test, vi } from "vitest";
import { executeAssist } from "./assist.ts";
import { ApprovalInputInterruptedError } from "./prompts.ts";
import {
  adminAgent,
  approvalDecision,
  approvalList,
  jsonSse,
  sessionId,
} from "./test/approval-transport.ts";

test("Ctrl+C before a recovery decision leaves the approval pending and prints a receipt", async () => {
  const requests: Array<{ method: string; url: string }> = [];
  let stdout = "";
  let tuiLoads = 0;
  await executeAssist({
    apiKey: "ba_test",
    configuration: { baseUrl: "https://api.example.com", source: "flag" },
    fetch: (url, init) => {
      requests.push({ method: init?.method ?? "GET", url });
      if (url.endsWith("/v1/agents")) {
        return Promise.resolve(Response.json({ agents: [adminAgent] }));
      }
      if (url.endsWith("/messages?limit=1")) {
        return Promise.resolve(
          Response.json({ data: [], latestCursor: null, nextCursor: null })
        );
      }
      return approvalList({
        continuation: null,
        data: [
          {
            approvalId: "approval-pending",
            decision: "pending",
            input: { action: "deleteById", agentId: "ag_target" },
            reason: null,
            toolCallId: "call-pending",
            toolName: "agents",
          },
        ],
      });
    },
    loadTui: () => {
      tuiLoads += 1;
      return Promise.resolve({ runAgentTUI: () => Promise.resolve() });
    },
    readApproval: () =>
      Promise.reject(new ApprovalInputInterruptedError("Interrupted")),
    sessionId,
    stdout: (text) => {
      stdout += text;
    },
  });

  expect(requests.some(({ method }) => method === "POST")).toBe(false);
  expect(tuiLoads).toBe(0);
  expect(stdout).toBe(
    `Session: ${sessionId}\nResume:  ba assist --session ${sessionId}\n`
  );
});

test("Ctrl+C after continuation admission detaches without starting the TUI", async () => {
  let interrupt: () => void = () => undefined;
  let joinStartedResolve: () => void = () => undefined;
  const joinStarted = new Promise<void>((resolve) => {
    joinStartedResolve = resolve;
  });
  let approvalReads = 0;
  let tuiLoads = 0;
  let stdout = "";
  const fetch: NonNullable<BlazingAgentsOptions["fetch"]> = (url, init) => {
    if (url.endsWith("/v1/agents")) {
      return Promise.resolve(Response.json({ agents: [adminAgent] }));
    }
    if (url.endsWith("/messages?limit=1")) {
      return Promise.resolve(
        Response.json({ data: [], latestCursor: null, nextCursor: null })
      );
    }
    if (url.endsWith("/tool-approvals/approval-admitted")) {
      return approvalDecision({
        continuationId: "continuation-admitted",
        state: "queued",
      });
    }
    if (url.endsWith("/tool-approvals")) {
      approvalReads += 1;
      return approvalList({
        continuation: null,
        data: [
          {
            approvalId: "approval-admitted",
            decision: approvalReads === 1 ? "pending" : "approved",
            input: { action: "updateById" },
            reason: null,
            toolCallId: "call-admitted",
            toolName: "agents",
          },
        ],
      });
    }
    if (url.endsWith("/continuation-admitted")) {
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              joinStartedResolve();
              init?.signal?.addEventListener("abort", () => {
                controller.error(new DOMException("Aborted", "AbortError"));
              });
            },
          }),
          { headers: { "content-type": "text/event-stream" } }
        )
      );
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  };

  const running = executeAssist({
    apiKey: "ba_test",
    configuration: { baseUrl: "https://api.example.com", source: "flag" },
    fetch,
    loadTui: () => {
      tuiLoads += 1;
      return Promise.resolve({ runAgentTUI: () => Promise.resolve() });
    },
    onSignal: (_signal, listener) => {
      interrupt = listener;
      return () => undefined;
    },
    readApproval: () => Promise.resolve(true),
    sessionId,
    stdout: (text) => {
      stdout += text;
    },
  });
  await joinStarted;
  interrupt();

  await expect(running).resolves.toBeUndefined();
  expect(tuiLoads).toBe(0);
  expect(stdout).toContain(`Resume:  ba assist --session ${sessionId}\n`);
});

test("recovery renders Tool outcomes and text before the clean TUI", async () => {
  let stdout = "";
  let tuiLoads = 0;
  const fetch: NonNullable<BlazingAgentsOptions["fetch"]> = (url) => {
    if (url.endsWith("/v1/agents")) {
      return Promise.resolve(Response.json({ agents: [adminAgent] }));
    }
    if (url.endsWith("/messages?limit=1")) {
      return Promise.resolve(
        Response.json({ data: [], latestCursor: null, nextCursor: null })
      );
    }
    if (url.endsWith("/tool-approvals")) {
      return approvalList({
        continuation: { id: "continuation-outcomes", state: "succeeded" },
        data: [],
      });
    }
    return Promise.resolve(
      jsonSse([
        {
          type: "tool-input-start",
          toolCallId: "call-failed",
          toolName: "agents",
        },
        {
          type: "tool-output-error",
          toolCallId: "call-failed",
          errorText: "Agent no longer exists",
        },
        {
          type: "tool-input-available",
          toolCallId: "call-denied",
          toolName: "sessions",
          input: { action: "deleteById" },
        },
        { type: "tool-output-denied", toolCallId: "call-denied" },
        {
          type: "tool-output-available",
          toolCallId: "call-replayed",
          output: { replayed: true },
        },
        {
          type: "tool-output-error",
          toolCallId: "call-replayed-error",
          errorText: "Replayed failure",
        },
        {
          type: "tool-output-denied",
          toolCallId: "call-replayed-denial",
        },
        { type: "text-delta", id: "text-outcome", delta: "Settled safely." },
        { type: "finish", finishReason: "stop" },
      ])
    );
  };

  await executeAssist({
    apiKey: "ba_test",
    configuration: { baseUrl: "https://api.example.com", source: "flag" },
    fetch,
    loadTui: () => {
      tuiLoads += 1;
      return Promise.resolve({ runAgentTUI: () => Promise.resolve() });
    },
    sessionId,
    stdout: (text) => {
      stdout += text;
    },
  });

  expect(stdout).toContain("Tool agents failed: Agent no longer exists");
  expect(stdout).toContain('Tool sessions running: {"action":"deleteById"}');
  expect(stdout).toContain("Tool sessions denied");
  expect(stdout).toContain('Tool unknown succeeded: {"replayed":true}');
  expect(stdout).toContain("Tool unknown failed: Replayed failure");
  expect(stdout).toContain("Tool unknown denied");
  expect(stdout).toContain("Settled safely.");
  expect(tuiLoads).toBe(1);
});

test("a recovery stream error is safe, actionable, and prevents the TUI", async () => {
  let tuiLoads = 0;
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
        if (url.endsWith("/tool-approvals")) {
          return approvalList({
            continuation: { id: "continuation-error", state: "failed" },
            data: [],
          });
        }
        return Promise.resolve(
          jsonSse([{ type: "error", errorText: "Safe recovery failure" }])
        );
      },
      loadTui: () => {
        tuiLoads += 1;
        return Promise.resolve({ runAgentTUI: () => Promise.resolve() });
      },
      sessionId,
      stdout: (text) => {
        stdout += text;
      },
    })
  ).rejects.toThrow("Safe recovery failure");
  expect(tuiLoads).toBe(0);
  expect(stdout).toContain(`Resume:  ba assist --session ${sessionId}\n`);
});

test("Ctrl+C cannot turn an unverified Session failure into a receipt", async () => {
  let interrupt: () => void = () => undefined;
  let stdout = "";
  await expect(
    executeAssist({
      apiKey: "ba_test",
      configuration: { baseUrl: "https://api.example.com", source: "flag" },
      fetch: (url) => {
        if (url.endsWith("/v1/agents")) {
          return Promise.resolve(Response.json({ agents: [adminAgent] }));
        }
        interrupt();
        return Promise.resolve(
          Response.json(
            { error: { code: "not_found", message: "Session not found" } },
            { status: 404 }
          )
        );
      },
      loadTui: () => Promise.resolve({ runAgentTUI: () => Promise.resolve() }),
      onSignal: (_signal, listener) => {
        interrupt = listener;
        return () => undefined;
      },
      sessionId,
      stdout: (text) => {
        stdout += text;
      },
    })
  ).rejects.toThrow("Session not found");
  expect(stdout).toBe("");
});

test("Ctrl+C after verification stops before a recovery prompt", async () => {
  let interrupt: () => void = () => undefined;
  const readApproval = vi.fn(() => Promise.resolve(true));
  let stdout = "";
  await executeAssist({
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
      interrupt();
      return approvalList({
        continuation: null,
        data: [
          {
            approvalId: "approval-not-prompted",
            decision: "pending",
            input: { action: "deleteById" },
            reason: null,
            toolCallId: "call-not-prompted",
            toolName: "agents",
          },
        ],
      });
    },
    loadTui: () => Promise.resolve({ runAgentTUI: () => Promise.resolve() }),
    onSignal: (_signal, listener) => {
      interrupt = listener;
      return () => undefined;
    },
    readApproval,
    sessionId,
    stdout: (text) => {
      stdout += text;
    },
  });
  expect(readApproval).not.toHaveBeenCalled();
  expect(stdout).toContain(`Resume:  ba assist --session ${sessionId}\n`);
});

test("Ctrl+C while verification settles stops before approval state is read", async () => {
  let interrupt: () => void = () => undefined;
  const urls: string[] = [];
  let stdout = "";
  await executeAssist({
    apiKey: "ba_test",
    configuration: { baseUrl: "https://api.example.com", source: "flag" },
    fetch: (url) => {
      urls.push(url);
      if (url.endsWith("/v1/agents")) {
        return Promise.resolve(Response.json({ agents: [adminAgent] }));
      }
      interrupt();
      return Promise.resolve(
        Response.json({ data: [], latestCursor: null, nextCursor: null })
      );
    },
    loadTui: () => Promise.resolve({ runAgentTUI: () => Promise.resolve() }),
    onSignal: (_signal, listener) => {
      interrupt = listener;
      return () => undefined;
    },
    sessionId,
    stdout: (text) => {
      stdout += text;
    },
  });
  expect(urls).toHaveLength(2);
  expect(stdout).toContain(`Resume:  ba assist --session ${sessionId}\n`);
});

test("a settled explicit Session with no continuation starts a clean TUI", async () => {
  const urls: string[] = [];
  await executeAssist({
    apiKey: "ba_test",
    configuration: { baseUrl: "https://api.example.com", source: "flag" },
    fetch: (url) => {
      urls.push(url);
      if (url.endsWith("/v1/agents")) {
        return Promise.resolve(Response.json({ agents: [adminAgent] }));
      }
      if (url.endsWith("/messages?limit=1")) {
        return Promise.resolve(
          Response.json({ data: [], latestCursor: null, nextCursor: null })
        );
      }
      return approvalList({
        continuation: null,
        data: [
          {
            approvalId: "approval-settled",
            decision: "approved",
            input: { action: "updateById" },
            reason: null,
            toolCallId: "call-settled",
            toolName: "agents",
          },
        ],
      });
    },
    loadTui: () => Promise.resolve({ runAgentTUI: () => Promise.resolve() }),
    sessionId,
    stdout: () => undefined,
  });
  expect(urls.at(-1)).toContain("/tool-approvals");
});
