import type { BlazingAgentsUIMessageChunk } from "@blazingagents/sdk";

const SECRET_KEY =
  /api[-_]?key|authorization|cookie|credential|password|secret|token/i;
const PREVIEW_LENGTH = 160;

export class RunOperationalError extends Error {
  override name = "RunOperationalError";
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SECRET_KEY.test(key) ? "[REDACTED]" : redactSecrets(entry),
      ])
    );
  }
  return value;
}

export function safePreview(value: unknown): string {
  const serialized = JSON.stringify(redactSecrets(value)) ?? String(value);
  const singleLine = serialized.replaceAll(/\s+/g, " ");
  return singleLine.length <= PREVIEW_LENGTH
    ? singleLine
    : `${singleLine.slice(0, PREVIEW_LENGTH - 1)}…`;
}

interface ToolState {
  input: unknown;
  name: string;
  startedAt: number;
}

interface StreamState {
  approvals: Array<{ approvalId: string; toolCallId: string }>;
  tools: Map<string, ToolState>;
}

function reportTool({
  now,
  result,
  state,
  status,
  stderr,
  toolCallId,
  toolOutput,
}: {
  now: () => number;
  result: unknown;
  state: StreamState;
  status: "denied" | "failed" | "succeeded";
  stderr: (text: string) => void;
  toolCallId: string;
  toolOutput: "off" | "summary";
}) {
  if (status === "succeeded" && toolOutput === "off") {
    return;
  }
  const tool = state.tools.get(toolCallId) ?? {
    input: undefined,
    name: "unknown",
    startedAt: now(),
  };
  const duration = Math.max(0, now() - tool.startedAt);
  stderr(
    `[tool] ${tool.name.replaceAll(/\s+/g, " ").slice(0, 80)} ${status} ${duration}ms input=${safePreview(tool.input)} result=${safePreview(result)}\n`
  );
}

function handleToolChunk(
  chunk: BlazingAgentsUIMessageChunk,
  context: {
    now: () => number;
    state: StreamState;
    stderr: (text: string) => void;
    toolOutput: "off" | "summary";
  }
): boolean {
  const { now, state } = context;
  switch (chunk.type) {
    case "tool-input-start":
      state.tools.set(chunk.toolCallId, {
        input: undefined,
        name: chunk.toolName,
        startedAt: now(),
      });
      return true;
    case "tool-input-available": {
      const current = state.tools.get(chunk.toolCallId);
      state.tools.set(chunk.toolCallId, {
        input: chunk.input,
        name: chunk.toolName,
        startedAt: current?.startedAt ?? now(),
      });
      return true;
    }
    case "tool-input-error":
      state.tools.set(chunk.toolCallId, {
        input: chunk.input,
        name: chunk.toolName,
        startedAt: state.tools.get(chunk.toolCallId)?.startedAt ?? now(),
      });
      reportTool({
        ...context,
        result: chunk.errorText,
        status: "failed",
        toolCallId: chunk.toolCallId,
      });
      return true;
    case "tool-output-available":
      if (!chunk.preliminary) {
        reportTool({
          ...context,
          result: chunk.output,
          status: "succeeded",
          toolCallId: chunk.toolCallId,
        });
      }
      return true;
    case "tool-output-error":
      reportTool({
        ...context,
        result: chunk.errorText,
        status: "failed",
        toolCallId: chunk.toolCallId,
      });
      return true;
    case "tool-output-denied":
      reportTool({
        ...context,
        result: "Tool approval was denied",
        status: "denied",
        toolCallId: chunk.toolCallId,
      });
      return true;
    case "tool-approval-request":
      if (!chunk.isAutomatic) {
        state.approvals.push({
          approvalId: chunk.approvalId,
          toolCallId: chunk.toolCallId,
        });
      }
      return true;
    case "tool-input-delta":
    case "tool-approval-response":
      return true;
    default:
      return false;
  }
}

export async function consumeSessionStream({
  buffered,
  now,
  sessionId,
  stderr,
  stdout,
  stream,
  toolOutput,
}: {
  buffered: boolean;
  now: () => number;
  sessionId: string;
  stderr: (text: string) => void;
  stdout: (text: string) => void;
  stream: ReadableStream<BlazingAgentsUIMessageChunk>;
  toolOutput: "off" | "summary";
}): Promise<string> {
  const state: StreamState = { approvals: [], tools: new Map() };
  let output = "";
  let finished = false;
  let failure: string | undefined;

  for await (const chunk of stream) {
    if (handleToolChunk(chunk, { now, state, stderr, toolOutput })) {
      continue;
    }
    switch (chunk.type) {
      case "text-delta":
        output += chunk.delta;
        if (!buffered) {
          stdout(chunk.delta);
        }
        break;
      case "error":
        failure = chunk.errorText;
        break;
      case "abort":
        failure = chunk.reason ?? "The Turn was aborted.";
        break;
      case "finish":
        finished = true;
        if (chunk.finishReason === "error") {
          failure = "The Turn failed during generation.";
        }
        break;
      default:
        break;
    }
  }

  if (!(finished || failure)) {
    failure = "The response stream ended before the Turn finished.";
  }
  if (state.approvals.length > 0) {
    for (const approval of state.approvals) {
      const tool = state.tools.get(approval.toolCallId);
      stderr(
        `Approval pending: ${approval.approvalId} tool=${tool?.name ?? "unknown"} session=${sessionId} input=${safePreview(tool?.input)}. Use ba assist --session ${sessionId} to decide it.\n`
      );
    }
    throw new RunOperationalError("The Turn requires human approval.");
  }
  if (failure) {
    throw new RunOperationalError(failure);
  }
  return output;
}
