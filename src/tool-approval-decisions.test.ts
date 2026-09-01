import { BlazingAgents } from "@blazingagents/sdk";
import { expect, test } from "vitest";
import { approvalList } from "./test/approval-transport.ts";
import { submitToolApprovalDecision } from "./tool-approval-decisions.ts";

const agentId = "ag_admAAAAAAAAAAAAA";
const sessionId = "ss_AAAAAAAAAAAAAAAA";

function client(fetch: typeof globalThis.fetch) {
  return new BlazingAgents({
    apiKey: "ba_test",
    baseUrl: "https://api.example.com",
    fetch,
  });
}

test("non-stale decision failures pass through without recovery guessing", async () => {
  const urls: string[] = [];
  await expect(
    submitToolApprovalDecision({
      agentId,
      approvalId: "approval-failed",
      approved: true,
      client: client((url) => {
        urls.push(String(url));
        return Promise.resolve(
          Response.json(
            { error: { code: "unavailable", message: "Approval unavailable" } },
            { status: 503 }
          )
        );
      }),
      sessionId,
    })
  ).rejects.toThrow("Approval unavailable");
  expect(urls).toHaveLength(1);
});

test("a conflicting trusted decision remains a conflict after reread", async () => {
  let request = 0;
  await expect(
    submitToolApprovalDecision({
      agentId,
      approvalId: "approval-conflict",
      approved: false,
      client: client(() => {
        request += 1;
        return Promise.resolve(
          request === 1
            ? Response.json(
                {
                  error: {
                    code: "invalid_request",
                    message: "Tool approval decision conflicts",
                  },
                },
                { status: 409 }
              )
            : approvalList({
                continuation: {
                  id: "continuation-conflict",
                  state: "succeeded",
                },
                data: [
                  {
                    approvalId: "approval-conflict",
                    decision: "approved",
                    input: { action: "updateById" },
                    reason: null,
                    toolCallId: "call-conflict",
                    toolName: "agents",
                  },
                ],
              })
        );
      }),
      sessionId,
    })
  ).rejects.toThrow("Tool approval decision conflicts");
  expect(request).toBe(2);
});

test("a stale denial rejoins the trusted matching continuation", async () => {
  let request = 0;
  await expect(
    submitToolApprovalDecision({
      agentId,
      approvalId: "approval-denied",
      approved: false,
      client: client(() => {
        request += 1;
        return Promise.resolve(
          request === 1
            ? Response.json(
                {
                  error: {
                    code: "invalid_request",
                    message: "Tool approval decision conflicts",
                  },
                },
                { status: 409 }
              )
            : approvalList({
                continuation: {
                  id: "continuation-denied",
                  state: "succeeded",
                },
                data: [
                  {
                    approvalId: "approval-denied",
                    decision: "denied",
                    input: { action: "deleteById" },
                    reason: null,
                    toolCallId: "call-denied",
                    toolName: "agents",
                  },
                ],
              })
        );
      }),
      sessionId,
    })
  ).resolves.toEqual({
    continuationId: "continuation-denied",
    state: "succeeded",
  });
});
