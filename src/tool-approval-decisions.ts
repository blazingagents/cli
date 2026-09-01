import { type BlazingAgents, BlazingAgentsError } from "@blazingagents/sdk";

export async function submitToolApprovalDecision({
  agentId,
  approvalId,
  approved,
  client,
  sessionId,
  signal,
}: {
  agentId: string;
  approvalId: string;
  approved: boolean;
  client: BlazingAgents;
  sessionId: string;
  signal?: AbortSignal;
}) {
  try {
    return await client.sessions.decideToolApproval(
      agentId,
      sessionId,
      approvalId,
      { approved },
      signal ? { signal } : undefined
    );
  } catch (error) {
    if (!(BlazingAgentsError.isInstance(error) && error.status === 409)) {
      throw error;
    }
    const trusted = await client.sessions.toolApprovals(agentId, sessionId);
    const stored = trusted.data.find(
      (approval) => approval.approvalId === approvalId
    );
    const expectedDecision = approved ? "approved" : "denied";
    if (stored?.decision !== expectedDecision || !trusted.continuation) {
      throw error;
    }
    return {
      continuationId: trusted.continuation.id,
      state: trusted.continuation.state,
    };
  }
}
