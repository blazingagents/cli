import type { BlazingAgentsUIMessageChunk } from "@blazingagents/sdk";
import { parseJsonEventStream, uiMessageChunkSchema } from "ai";

/**
 * The CLI consumes the AI SDK UI-message protocol instead of relaying it to a
 * browser, so decoding belongs here rather than in the backend relay SDK.
 */
export function decodeUIMessageResponse(
  response: Response
): ReadableStream<BlazingAgentsUIMessageChunk> {
  if (!response.body) {
    throw new Error("The server returned an empty UI-message stream.");
  }
  const reader = parseJsonEventStream({
    schema: uiMessageChunkSchema,
    stream: response.body,
  }).getReader();

  return new ReadableStream<BlazingAgentsUIMessageChunk>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          return;
        }
        if (!result.value.success) {
          throw result.value.error;
        }
        controller.enqueue(result.value.value as BlazingAgentsUIMessageChunk);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
