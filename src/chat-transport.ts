import type {
  BlazingAgents,
  BlazingAgentsUIMessageChunk,
  ChatResult,
} from "@blazingagents/sdk";
import {
  type ChatTransport,
  isToolUIPart,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { submitToolApprovalDecision } from "./tool-approval-decisions.ts";
import { decodeUIMessageResponse } from "./ui-message-stream.ts";

export interface ChatReceipt {
  inputTokens: number;
  outputTokens: number;
  sessionId: string;
}

export class BlazingChatTransport implements ChatTransport<UIMessage> {
  readonly #agentId: string;
  readonly #client: BlazingAgents;
  #inputTokens = 0;
  #outputTokens = 0;
  #sessionId?: string;
  readonly #submittedApprovalIds = new Set<string>();

  constructor({
    agentId,
    client,
    sessionId,
  }: {
    agentId: string;
    client: BlazingAgents;
    sessionId?: string;
  }) {
    this.#agentId = agentId;
    this.#client = client;
    this.#sessionId = sessionId;
  }

  get receipt(): ChatReceipt | undefined {
    return this.#sessionId
      ? {
          inputTokens: this.#inputTokens,
          outputTokens: this.#outputTokens,
          sessionId: this.#sessionId,
        }
      : undefined;
  }

  async sendMessages({
    abortSignal,
    messageId,
    messages,
    trigger,
  }: Parameters<ChatTransport<UIMessage>["sendMessages"]>[0]) {
    const approvals = messages.flatMap((candidateMessage) =>
      candidateMessage.role === "assistant"
        ? candidateMessage.parts.flatMap((part) =>
            isToolUIPart(part) &&
            part.state === "approval-responded" &&
            part.approval.isAutomatic !== true &&
            !this.#submittedApprovalIds.has(part.approval.id)
              ? [
                  {
                    approvalId: part.approval.id,
                    approved: part.approval.approved,
                  },
                ]
              : []
          )
        : []
    );
    if (approvals.length > 0) {
      if (!this.#sessionId) {
        throw new Error("Tool approval requires a materialized Session.");
      }
      let continuationId = "";
      for (const approval of approvals) {
        const decision = await submitToolApprovalDecision({
          agentId: this.#agentId,
          approvalId: approval.approvalId,
          approved: approval.approved,
          client: this.#client,
          sessionId: this.#sessionId,
          signal: abortSignal,
        });
        this.#submittedApprovalIds.add(approval.approvalId);
        continuationId = decision.continuationId;
      }
      const continuation =
        await this.#client.sessions.joinToolApprovalContinuation(
          this.#agentId,
          this.#sessionId,
          continuationId,
          abortSignal ? { signal: abortSignal } : undefined
        );
      return this.#projectStream(
        decodeUIMessageResponse(continuation.toResponse())
      );
    }

    const message = messages.findLast(({ role }) => role === "user");
    if (!message) {
      throw new Error("The TUI did not supply a user message.");
    }
    const chatInput = {
      agentId: this.#agentId,
      message,
      messageId,
      signal: abortSignal,
    };
    let result: ChatResult;
    if (this.#sessionId === undefined) {
      if (trigger === "regenerate-message") {
        throw new Error(
          "regenerate-message can only resume an existing Session."
        );
      }
      result = await this.#client.chat({ ...chatInput, trigger });
    } else {
      result = await this.#client.chat({
        ...chatInput,
        sessionId: this.#sessionId,
        trigger,
      });
    }
    this.#sessionId = await result.sessionId;
    return this.#projectStream(decodeUIMessageResponse(result.toResponse()));
  }

  #projectStream(stream: ReadableStream<BlazingAgentsUIMessageChunk>) {
    return stream.pipeThrough(
      new TransformStream<BlazingAgentsUIMessageChunk, UIMessageChunk>({
        transform: (chunk, controller) => {
          const messageMetadata =
            "messageMetadata" in chunk ? chunk.messageMetadata : undefined;
          const usage = messageMetadata?.blazingAgents.usage;
          if (chunk.type === "finish" && usage) {
            this.#inputTokens += usage.inputTokens;
            this.#outputTokens += usage.outputTokens;
          }
          controller.enqueue(
            usage
              ? ({
                  ...chunk,
                  messageMetadata: {
                    ...messageMetadata,
                    usage: {
                      inputTokens: usage.inputTokens,
                      outputTokens: usage.outputTokens,
                    },
                  },
                } as UIMessageChunk)
              : chunk
          );
        },
      })
    );
  }

  reconnectToStream(
    _options: Parameters<ChatTransport<UIMessage>["reconnectToStream"]>[0]
  ) {
    return Promise.resolve(null);
  }
}
