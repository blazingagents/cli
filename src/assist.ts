import {
  BlazingAgents,
  type BlazingAgentsOptions,
  type BlazingAgentsUIMessageChunk,
} from "@blazingagents/sdk";
import { BlazingChatTransport } from "./chat-transport.ts";
import type { ResolvedConfiguration } from "./config.ts";
import { isAdminAgentId } from "./contracts.ts";
import {
  ApprovalInputInterruptedError,
  readApprovalDecision,
} from "./prompts.ts";
import { submitToolApprovalDecision } from "./tool-approval-decisions.ts";
import { runTerminalTui, type TuiLoader } from "./tui.ts";
import { decodeUIMessageResponse } from "./ui-message-stream.ts";

export class AssistOperationalError extends Error {
  override name = "AssistOperationalError";
}

type SignalRegistrar = (signal: "SIGINT", listener: () => void) => () => void;

function recoveryPrompt(input: { input: unknown; toolName: string }): string {
  return `\nPending Tool approval\nTool: ${input.toolName}\nInput:\n${JSON.stringify(input.input, null, 2)}\nApprove? y/n `;
}

async function renderRecoveryStream(
  stream: ReadableStream<BlazingAgentsUIMessageChunk>,
  stdout: (text: string) => void,
  trustedTools: Iterable<readonly [string, string]>
): Promise<void> {
  const toolNamesByCallId = new Map(trustedTools);
  let streamError: string | undefined;
  for await (const chunk of stream) {
    switch (chunk.type) {
      case "tool-input-start":
        toolNamesByCallId.set(chunk.toolCallId, chunk.toolName);
        break;
      case "tool-input-available":
        toolNamesByCallId.set(chunk.toolCallId, chunk.toolName);
        stdout(
          `Tool ${chunk.toolName} running: ${JSON.stringify(chunk.input)}\n`
        );
        break;
      case "tool-output-available":
        stdout(
          `Tool ${toolNamesByCallId.get(chunk.toolCallId) ?? "unknown"} succeeded: ${JSON.stringify(chunk.output)}\n`
        );
        break;
      case "tool-output-error":
        stdout(
          `Tool ${toolNamesByCallId.get(chunk.toolCallId) ?? "unknown"} failed: ${chunk.errorText}\n`
        );
        break;
      case "tool-output-denied":
        stdout(
          `Tool ${toolNamesByCallId.get(chunk.toolCallId) ?? "unknown"} denied\n`
        );
        break;
      case "text-delta":
        stdout(chunk.delta);
        break;
      case "error":
        streamError = chunk.errorText;
        break;
      default:
        break;
    }
  }
  stdout("\n");
  if (streamError) {
    throw new AssistOperationalError(streamError);
  }
}

function printReceipt(sessionId: string, stdout: (text: string) => void): void {
  stdout(`Session: ${sessionId}\nResume:  ba assist --session ${sessionId}\n`);
}

async function recoverSession({
  adminAgentId,
  client,
  onSignal,
  readApproval,
  sessionId,
  stdout,
}: {
  adminAgentId: string;
  client: BlazingAgents;
  onSignal?: SignalRegistrar;
  readApproval: (prompt: string) => Promise<boolean>;
  sessionId: string;
  stdout: (text: string) => void;
}): Promise<boolean> {
  const recoveryAbort = new AbortController();
  const removeSignal = onSignal?.("SIGINT", () => recoveryAbort.abort());
  let verifiedSession = false;
  try {
    await client.sessions.messages(adminAgentId, sessionId, { limit: 1 });
    verifiedSession = true;
    if (recoveryAbort.signal.aborted) {
      throw new ApprovalInputInterruptedError("Recovery interrupted");
    }
    let approvals = await client.sessions.toolApprovals(
      adminAgentId,
      sessionId
    );
    let continuationId = approvals.continuation?.id;
    for (const approval of approvals.data) {
      if (approval.decision !== "pending") {
        continue;
      }
      if (recoveryAbort.signal.aborted) {
        throw new ApprovalInputInterruptedError("Recovery interrupted");
      }
      const approved = await readApproval(recoveryPrompt(approval));
      const decision = await submitToolApprovalDecision({
        agentId: adminAgentId,
        approvalId: approval.approvalId,
        approved,
        client,
        sessionId,
        signal: recoveryAbort.signal,
      });
      continuationId = decision.continuationId;
    }
    approvals = await client.sessions.toolApprovals(adminAgentId, sessionId);
    continuationId ??= approvals.continuation?.id;
    if (continuationId) {
      const continuation = await client.sessions.joinToolApprovalContinuation(
        adminAgentId,
        sessionId,
        continuationId,
        { signal: recoveryAbort.signal }
      );
      await renderRecoveryStream(
        decodeUIMessageResponse(continuation.toResponse()),
        stdout,
        approvals.data.map(
          ({ toolCallId, toolName }) => [toolCallId, toolName] as const
        )
      );
    }
    return true;
  } catch (error) {
    if (
      error instanceof ApprovalInputInterruptedError ||
      (verifiedSession && recoveryAbort.signal.aborted)
    ) {
      printReceipt(sessionId, stdout);
      return false;
    }
    if (verifiedSession) {
      printReceipt(sessionId, stdout);
    }
    throw error;
  } finally {
    removeSignal?.();
  }
}

export async function executeAssist({
  apiKey,
  configuration,
  fetch,
  loadTui = () => import("@ai-sdk/tui"),
  onSignal,
  readApproval = readApprovalDecision,
  sessionId,
  stdout,
  terminal = process.stdin,
}: {
  apiKey: string;
  configuration: ResolvedConfiguration;
  fetch?: BlazingAgentsOptions["fetch"];
  loadTui?: TuiLoader;
  onSignal?: SignalRegistrar;
  readApproval?: (prompt: string) => Promise<boolean>;
  sessionId?: string;
  stdout: (text: string) => void;
  terminal?: {
    isTTY?: boolean;
    pause: () => unknown;
    setRawMode?: (mode: boolean) => unknown;
  };
}): Promise<void> {
  const client = new BlazingAgents({
    apiKey,
    baseUrl: configuration.baseUrl,
    ...(fetch ? { fetch } : {}),
  });
  const { agents } = await client.agents.list();
  const adminAgents = agents.filter(({ id }) => isAdminAgentId(id));
  if (adminAgents.length !== 1) {
    throw new AssistOperationalError(
      `BA Assist requires exactly one visible Admin Agent; found ${adminAgents.length}. Contact your platform administrator.`
    );
  }
  const adminAgent = adminAgents[0];
  if (adminAgent.providerId === null || adminAgent.model === null) {
    throw new AssistOperationalError(
      "BA Assist needs an Admin Agent Provider and model. Add a Provider in the dashboard, then select its model on the Admin Agent."
    );
  }

  if (
    sessionId &&
    !(await recoverSession({
      adminAgentId: adminAgent.id,
      client,
      onSignal,
      readApproval,
      sessionId,
      stdout,
    }))
  ) {
    return;
  }

  const transport = new BlazingChatTransport({
    agentId: adminAgent.id,
    client,
    sessionId,
  });
  try {
    await runTerminalTui({
      loadTui,
      options: {
        responseStatistics: "outputTokenCount",
        title: "BA Assist",
        transport,
      },
      stdout,
      terminal,
    });
  } catch (error) {
    const receipt = transport.receipt;
    if (receipt) {
      printReceipt(receipt.sessionId, stdout);
    }
    throw error;
  }

  const receipt = transport.receipt;
  if (receipt) {
    printReceipt(receipt.sessionId, stdout);
  }
}
