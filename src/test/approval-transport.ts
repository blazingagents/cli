import type { Agent, BlazingAgentsUIMessageChunk } from "@blazingagents/sdk";
import type {
  ToolApprovalDecisionResponse,
  ToolApprovalsResponse,
} from "../contracts.ts";

export const adminAgentId = "ag_admAAAAAAAAAAAAA";
export const sessionId = "ss_AAAAAAAAAAAAAAAA";

export const adminAgent = {
  avatarUrl: null,
  createdAt: "2026-07-16T10:00:00.000Z",
  id: adminAgentId,
  instructions: "",
  mcpConnectionIds: [],
  memoryInjectionEnabled: false,
  metadata: {},
  model: "openrouter/test-model",
  name: "Admin Agent",
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

export function approvalList(body: ToolApprovalsResponse): Promise<Response> {
  return Promise.resolve(Response.json(body));
}

export function approvalDecision(
  body: ToolApprovalDecisionResponse
): Promise<Response> {
  return Promise.resolve(Response.json(body, { status: 202 }));
}

export function jsonSse(
  chunks: BlazingAgentsUIMessageChunk[],
  options: { headers?: HeadersInit; status?: number } = {}
): Response {
  return new Response(
    chunks
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
      .concat("data: [DONE]\n\n")
      .join(""),
    {
      headers: { "content-type": "text/event-stream", ...options.headers },
      status: options.status,
    }
  );
}
