import type { BlazingAgentsUIMessageChunk } from "@blazingagents/sdk";
import { describe, expect, it } from "vitest";
import { decodeUIMessageResponse } from "./ui-message-stream.ts";

function responseFromText(text: string): Response {
  return new Response(text, {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("decodeUIMessageResponse", () => {
  it("decodes AI SDK UI-message SSE for CLI consumers", async () => {
    const stream = decodeUIMessageResponse(
      responseFromText(
        'data: {"type":"text-start","id":"text-1"}\n\n' +
          'data: {"type":"text-delta","id":"text-1","delta":"Hello"}\n\n' +
          "data: [DONE]\n\n"
      )
    );
    const chunks: BlazingAgentsUIMessageChunk[] = [];

    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "Hello" },
    ]);
  });

  it("rejects a response without a body", () => {
    expect(() => decodeUIMessageResponse(new Response(null))).toThrow(
      "The server returned an empty UI-message stream."
    );
  });

  it("surfaces malformed UI-message events", async () => {
    const reader = decodeUIMessageResponse(
      responseFromText("data: {not-json}\n\n")
    ).getReader();

    await expect(reader.read()).rejects.toBeDefined();
  });

  it("allows the decoded stream to be canceled", async () => {
    const response = new Response(new ReadableStream<Uint8Array>());

    await expect(
      decodeUIMessageResponse(response).cancel("closed")
    ).resolves.toBeUndefined();
  });
});
