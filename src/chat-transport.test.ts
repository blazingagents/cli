import {
  BlazingAgents,
  type BlazingAgentsOptions,
  type BlazingAgentsUIMessageChunk,
} from "@blazingagents/sdk";
import type { UIMessage, UIMessageChunk } from "ai";
import { expect, test } from "vitest";
import { BlazingChatTransport } from "./chat-transport.ts";
import type { UsageSummary } from "./contracts.ts";
import {
  approvalDecision,
  approvalList,
  jsonSse,
  sessionId,
} from "./test/approval-transport.ts";

const agentId = "ag_AAAAAAAAAAAAAAAA";

function usage(turn: number): UsageSummary {
  return {
    agentId,
    agentVersion: 1,
    commitId: `commit-${turn}`,
    completedAt: "2026-07-16T10:00:01.000Z",
    durationMs: 1000,
    errorMessage: null,
    inputTokens: 8,
    modelDurationMs: 750,
    metadata: {},
    modelId: "openrouter/test-model",
    outputTokens: 3,
    turnId: `turn_${String(turn).padStart(16, "0")}`,
    sessionId,
    startedAt: "2026-07-16T10:00:00.000Z",
    status: "succeeded",
    stepUsages: [],
    tenantId: "ten_AAAAAAAAAAAAAAAA",
    userId: "",
  };
}

test("the shared transport sends only the latest user message and ignores the TUI chat id", async () => {
  const requests: Array<{ body: unknown; url: string }> = [];
  const fetch: NonNullable<BlazingAgentsOptions["fetch"]> = (url, init) => {
    requests.push({
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      url,
    });
    return Promise.resolve(
      jsonSse(
        [
          { type: "start", messageId: "assistant-current" },
          { type: "finish", finishReason: "stop" },
        ],
        {
          headers: {
            location: `/v1/agents/${agentId}/sessions/${sessionId}`,
          },
          status: 201,
        }
      )
    );
  };
  const transport = new BlazingChatTransport({
    agentId,
    client: new BlazingAgents({
      apiKey: "ba_test",
      baseUrl: "https://api.example.com",
      fetch,
    }),
  });
  const messages: UIMessage[] = [
    {
      id: "user-old",
      parts: [{ text: "old prompt", type: "text" }],
      role: "user",
    },
    {
      id: "assistant-old",
      parts: [{ text: "old answer", type: "text" }],
      role: "assistant",
    },
    {
      id: "user-current",
      parts: [{ text: "current prompt", type: "text" }],
      role: "user",
    },
  ];

  const chunks: UIMessageChunk[] = [];
  for await (const chunk of await transport.sendMessages({
    abortSignal: undefined,
    chatId: "tui-internal-id",
    messageId: undefined,
    messages,
    trigger: "submit-message",
  })) {
    chunks.push(chunk);
  }

  expect(chunks.at(-1)).toEqual({ type: "finish", finishReason: "stop" });
  expect(requests).toEqual([
    {
      body: {
        message: messages.at(-1),
        trigger: "submit-message",
      },
      url: `https://api.example.com/v1/agents/${agentId}/sessions`,
    },
  ]);
});

test("an admitted Session survives a failed first Turn and later Turns resume it", async () => {
  const urls: string[] = [];
  let turn = 0;
  // biome-ignore lint/suspicious/useAwait: synchronous fixture implements the SDK fetch contract
  const fetch: NonNullable<BlazingAgentsOptions["fetch"]> = async (url) => {
    urls.push(url);
    turn += 1;
    if (turn === 1) {
      return jsonSse(
        [
          { type: "start", messageId: "assistant-failed" },
          { type: "error", errorText: "Safe streamed failure" },
        ],
        {
          headers: {
            location: `/v1/agents/${agentId}/sessions/${sessionId}`,
          },
          status: 201,
        }
      );
    }
    return jsonSse(
      [
        { type: "start", messageId: `assistant-${turn}` },
        {
          type: "finish",
          finishReason: "stop",
          messageMetadata: {
            blazingAgents: {
              usage: usage(turn),
            },
          },
        },
      ],
      {
        headers: { location: `/v1/agents/${agentId}/sessions/${sessionId}` },
        status: 201,
      }
    );
  };
  const transport = new BlazingChatTransport({
    agentId,
    client: new BlazingAgents({
      apiKey: "ba_test",
      baseUrl: "https://api.example.com",
      fetch,
    }),
  });
  const userMessage = (id: string): UIMessage => ({
    id,
    parts: [{ text: id, type: "text" }],
    role: "user",
  });
  const send = async (id: string) => {
    const chunks: UIMessageChunk[] = [];
    for await (const chunk of await transport.sendMessages({
      abortSignal: undefined,
      chatId: "never-a-platform-session",
      messageId: undefined,
      messages: [userMessage(id)],
      trigger: "submit-message",
    })) {
      chunks.push(chunk);
    }
    return chunks;
  };

  await send("failed");
  expect(transport.receipt).toEqual({
    inputTokens: 0,
    outputTokens: 0,
    sessionId,
  });
  const successfulChunks = await send("successful");
  expect(transport.receipt).toEqual({
    inputTokens: 8,
    outputTokens: 3,
    sessionId,
  });
  expect(successfulChunks.at(-1)).toMatchObject({
    messageMetadata: {
      blazingAgents: { usage: { inputTokens: 8, outputTokens: 3 } },
      usage: { inputTokens: 8, outputTokens: 3 },
    },
    type: "finish",
  });
  await send("resumed");
  expect(transport.receipt).toEqual({
    inputTokens: 16,
    outputTokens: 6,
    sessionId,
  });

  expect(urls).toEqual([
    `https://api.example.com/v1/agents/${agentId}/sessions`,
    `https://api.example.com/v1/agents/${agentId}/sessions/${sessionId}`,
    `https://api.example.com/v1/agents/${agentId}/sessions/${sessionId}`,
  ]);
});

test("an explicit Session is resumable even when no new Turn succeeds", async () => {
  const transport = new BlazingChatTransport({
    agentId,
    client: new BlazingAgents({
      apiKey: "ba_test",
      baseUrl: "https://api.example.com",
      fetch: () => Promise.reject(new Error("no Turn expected")),
    }),
    sessionId,
  });

  expect(transport.receipt).toEqual({
    inputTokens: 0,
    outputTokens: 0,
    sessionId,
  });
  await expect(
    transport.reconnectToStream({ chatId: "tui-internal-id" })
  ).resolves.toBeNull();
});

test("live Tool approval responses persist sequentially and expose one continuation stream", async () => {
  const requests: Array<{ body: unknown; method: string; url: string }> = [];
  const continuationChunks = [
    { type: "start", messageId: "assistant-approval" },
    {
      type: "tool-output-available",
      toolCallId: "call-first",
      output: { updated: true },
    },
    { type: "text-start", id: "text-continuation" },
    {
      type: "text-delta",
      id: "text-continuation",
      delta: "Both decisions settled.",
    },
    { type: "text-end", id: "text-continuation" },
    { type: "finish", finishReason: "stop" },
  ] satisfies BlazingAgentsUIMessageChunk[];
  const fetch: NonNullable<BlazingAgentsOptions["fetch"]> = (url, init) => {
    requests.push({
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      method: init?.method ?? "GET",
      url,
    });
    if (url.includes("/tool-approvals/")) {
      return approvalDecision({
        continuationId: "continuation-one",
        state: url.endsWith("approval-first") ? "waiting" : "queued",
      });
    }
    if (url.endsWith("/tool-approval-continuations/continuation-one")) {
      return Promise.resolve(jsonSse(continuationChunks, { status: 201 }));
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const transport = new BlazingChatTransport({
    agentId,
    client: new BlazingAgents({
      apiKey: "ba_test",
      baseUrl: "https://api.example.com",
      fetch,
    }),
    sessionId,
  });
  const messages: UIMessage[] = [
    {
      id: "user-approval",
      parts: [{ text: "Update both Agents", type: "text" }],
      role: "user",
    },
    {
      id: "assistant-approval",
      role: "assistant",
      parts: [
        {
          approval: { approved: true, id: "approval-first" },
          input: {
            action: "updateById",
            agentId: "ag_BBBBBBBBBBBBBBBB",
          },
          state: "approval-responded",
          toolCallId: "call-first",
          toolName: "agents",
          type: "dynamic-tool",
        },
        {
          approval: {
            approved: false,
            id: "approval-second",
            reason: "Denied by user.",
          },
          input: {
            action: "deleteById",
            agentId: "ag_CCCCCCCCCCCCCCCC",
          },
          state: "approval-responded",
          toolCallId: "call-second",
          toolName: "agents",
          type: "dynamic-tool",
        },
      ],
    },
  ];

  const received: UIMessageChunk[] = [];
  for await (const chunk of await transport.sendMessages({
    abortSignal: new AbortController().signal,
    chatId: "tui-internal-id",
    messageId: undefined,
    messages,
    trigger: "submit-message",
  })) {
    received.push(chunk);
  }

  expect(received).toEqual(continuationChunks);
  expect(requests).toEqual([
    {
      body: { approved: true },
      method: "POST",
      url: `https://api.example.com/v1/agents/${agentId}/sessions/${sessionId}/tool-approvals/approval-first`,
    },
    {
      body: { approved: false },
      method: "POST",
      url: `https://api.example.com/v1/agents/${agentId}/sessions/${sessionId}/tool-approvals/approval-second`,
    },
    {
      body: undefined,
      method: "GET",
      url: `https://api.example.com/v1/agents/${agentId}/sessions/${sessionId}/tool-approval-continuations/continuation-one`,
    },
  ]);
});

test("a stale live decision response rereads trusted state before joining", async () => {
  const urls: string[] = [];
  const fetch: NonNullable<BlazingAgentsOptions["fetch"]> = (url) => {
    urls.push(url);
    if (url.endsWith("/tool-approvals/approval-stale")) {
      return Promise.resolve(
        Response.json(
          {
            error: {
              code: "invalid_request",
              message: "Tool approval decision conflicts",
            },
          },
          { status: 409 }
        )
      );
    }
    if (url.endsWith("/tool-approvals")) {
      return approvalList({
        continuation: { id: "continuation-stale", state: "succeeded" },
        data: [
          {
            approvalId: "approval-stale",
            decision: "approved",
            input: { action: "updateById" },
            reason: null,
            toolCallId: "call-stale",
            toolName: "agents",
          },
        ],
      });
    }
    if (url.endsWith("/tool-approval-continuations/continuation-stale")) {
      return Promise.resolve(
        jsonSse([{ type: "finish", finishReason: "stop" }], { status: 201 })
      );
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  };
  const transport = new BlazingChatTransport({
    agentId,
    client: new BlazingAgents({
      apiKey: "ba_test",
      baseUrl: "https://api.example.com",
      fetch,
    }),
    sessionId,
  });

  const stream = await transport.sendMessages({
    abortSignal: undefined,
    chatId: "tui-internal-id",
    messageId: undefined,
    messages: [
      {
        id: "assistant-stale",
        parts: [
          {
            approval: { approved: true, id: "approval-stale" },
            input: { action: "updateById" },
            state: "approval-responded",
            toolCallId: "call-stale",
            toolName: "agents",
            type: "dynamic-tool",
          },
        ],
        role: "assistant",
      },
    ],
    trigger: "submit-message",
  });
  await stream.pipeTo(new WritableStream());

  expect(urls).toEqual([
    `https://api.example.com/v1/agents/${agentId}/sessions/${sessionId}/tool-approvals/approval-stale`,
    `https://api.example.com/v1/agents/${agentId}/sessions/${sessionId}/tool-approvals`,
    `https://api.example.com/v1/agents/${agentId}/sessions/${sessionId}/tool-approval-continuations/continuation-stale`,
  ]);
});

test("approval responses require a materialized Session", async () => {
  const transport = new BlazingChatTransport({
    agentId,
    client: new BlazingAgents({
      apiKey: "ba_test",
      baseUrl: "https://api.example.com",
      fetch: () => Promise.reject(new Error("no request expected")),
    }),
  });

  await expect(
    transport.sendMessages({
      abortSignal: undefined,
      chatId: "tui-internal-id",
      messageId: undefined,
      messages: [
        {
          id: "assistant-unmaterialized",
          parts: [
            {
              approval: { approved: true, id: "approval-unmaterialized" },
              input: { action: "updateById" },
              state: "approval-responded",
              toolCallId: "call-unmaterialized",
              toolName: "agents",
              type: "dynamic-tool",
            },
          ],
          role: "assistant",
        },
      ],
      trigger: "submit-message",
    })
  ).rejects.toThrow("materialized Session");
});

test("automatic and already submitted approvals are never sent as live decisions", async () => {
  let decisionRequests = 0;
  const fetch: NonNullable<BlazingAgentsOptions["fetch"]> = (url) => {
    if (url.includes("/tool-approvals/approval-manual")) {
      decisionRequests += 1;
      return approvalDecision({
        continuationId: "continuation-manual",
        state: "queued",
      });
    }
    if (url.endsWith("/continuation-manual")) {
      return Promise.resolve(
        jsonSse([{ type: "finish", finishReason: "stop" }], { status: 201 })
      );
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  };
  const transport = new BlazingChatTransport({
    agentId,
    client: new BlazingAgents({
      apiKey: "ba_test",
      baseUrl: "https://api.example.com",
      fetch,
    }),
    sessionId,
  });
  const messages: UIMessage[] = [
    {
      id: "assistant-responses",
      parts: [
        {
          approval: {
            approved: true,
            id: "approval-automatic",
            isAutomatic: true,
          },
          input: { action: "create" },
          state: "approval-responded",
          toolCallId: "call-automatic",
          toolName: "agents",
          type: "dynamic-tool",
        },
        {
          approval: { approved: true, id: "approval-manual" },
          input: { action: "updateById" },
          state: "approval-responded",
          toolCallId: "call-manual",
          toolName: "agents",
          type: "dynamic-tool",
        },
      ],
      role: "assistant",
    },
  ];

  await (
    await transport.sendMessages({
      abortSignal: undefined,
      chatId: "tui-internal-id",
      messageId: undefined,
      messages,
      trigger: "submit-message",
    })
  ).pipeTo(new WritableStream());
  await expect(
    transport.sendMessages({
      abortSignal: undefined,
      chatId: "tui-internal-id",
      messageId: undefined,
      messages,
      trigger: "submit-message",
    })
  ).rejects.toThrow("did not supply a user message");
  expect(decisionRequests).toBe(1);
});

test("the transport rejects a TUI submission without a user message", async () => {
  const transport = new BlazingChatTransport({
    agentId,
    client: new BlazingAgents({
      apiKey: "ba_test",
      baseUrl: "https://api.example.com",
      fetch: () => Promise.reject(new Error("no request expected")),
    }),
  });

  await expect(
    transport.sendMessages({
      abortSignal: undefined,
      chatId: "tui-internal-id",
      messageId: undefined,
      messages: [],
      trigger: "submit-message",
    })
  ).rejects.toThrow("did not supply a user message");
});

test("the transport cannot regenerate before its Session materializes", async () => {
  const transport = new BlazingChatTransport({
    agentId,
    client: new BlazingAgents({
      apiKey: "ba_test",
      baseUrl: "https://api.example.com",
      fetch: () => Promise.reject(new Error("no request expected")),
    }),
  });

  await expect(
    transport.sendMessages({
      abortSignal: undefined,
      chatId: "tui-internal-id",
      messageId: undefined,
      messages: [
        {
          id: "user-unmaterialized",
          parts: [{ text: "retry", type: "text" }],
          role: "user",
        },
      ],
      trigger: "regenerate-message",
    })
  ).rejects.toThrow("regenerate-message can only resume an existing Session");
});
