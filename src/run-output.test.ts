import type { BlazingAgentsUIMessageChunk } from "@blazingagents/sdk";
import { expect, test } from "vitest";
import {
  consumeSessionStream,
  RunOperationalError,
  safePreview,
} from "./run-output.ts";

function chunkStream(chunks: BlazingAgentsUIMessageChunk[]) {
  return new ReadableStream<BlazingAgentsUIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

async function consume(
  chunks: BlazingAgentsUIMessageChunk[],
  overrides: Partial<Parameters<typeof consumeSessionStream>[0]> = {}
) {
  let stdout = "";
  let stderr = "";
  let tick = 0;
  const output = await consumeSessionStream({
    buffered: false,
    now: () => {
      tick += 5;
      return tick;
    },
    sessionId: "ss_AAAAAAAAAAAAAAAA",
    stderr: (text) => {
      stderr += text;
    },
    stdout: (text) => {
      stdout += text;
    },
    stream: chunkStream(chunks),
    toolOutput: "summary",
    ...overrides,
  });
  return { output, stderr, stdout };
}

const successfulText = [
  { type: "text-delta", id: "text", delta: "Hello " },
  { type: "text-delta", id: "text", delta: "world" },
  { type: "finish", finishReason: "stop" },
] satisfies BlazingAgentsUIMessageChunk[];

test("plain and buffered Session consumption keep stdout contracts", async () => {
  await expect(consume(successfulText)).resolves.toEqual({
    output: "Hello world",
    stderr: "",
    stdout: "Hello world",
  });
  let bufferedStdout = "";
  await expect(
    consume(successfulText, {
      buffered: true,
      stdout: (text) => {
        bufferedStdout += text;
      },
    })
  ).resolves.toMatchObject({ output: "Hello world" });
  expect(bufferedStdout).toBe("");
});

test("safe previews redact recursively, stay single-line, and are bounded", () => {
  const preview = safePreview({
    nested: [{ authorization: "bearer secret" }],
    password: "secret",
    text: `line one\n${"x".repeat(300)}`,
  });
  expect(preview.length).toBe(160);
  expect(preview).toContain("[REDACTED]");
  expect(preview).not.toContain("bearer secret");
  expect(preview).not.toContain("\n");
  expect(safePreview(undefined)).toBe("undefined");
  expect(safePreview("short")).toBe('"short"');
});

test("all Tool terminal states produce bounded diagnostics without affecting text", async () => {
  const chunks = [
    { type: "tool-input-start", toolCallId: "one", toolName: "search" },
    { type: "tool-input-delta", toolCallId: "one", inputTextDelta: "{}" },
    {
      type: "tool-input-available",
      toolCallId: "one",
      toolName: "search",
      input: { apiKey: "secret", query: "docs" },
    },
    {
      type: "tool-output-available",
      toolCallId: "one",
      output: { token: "secret" },
      preliminary: true,
    },
    {
      type: "tool-output-available",
      toolCallId: "one",
      output: { count: 1 },
    },
    {
      type: "tool-input-available",
      toolCallId: "two",
      toolName: "readFile",
      input: { path: "/tmp/a" },
    },
    { type: "tool-output-error", toolCallId: "two", errorText: "failed" },
    {
      type: "tool-input-error",
      toolCallId: "three",
      toolName: "writeFile",
      input: { value: 1 },
      errorText: "invalid",
    },
    { type: "tool-output-denied", toolCallId: "unknown" },
    {
      type: "tool-approval-request",
      approvalId: "automatic",
      toolCallId: "one",
      isAutomatic: true,
    },
    {
      type: "tool-approval-response",
      approvalId: "automatic",
      approved: true,
    },
    { type: "finish", finishReason: "stop" },
  ] satisfies BlazingAgentsUIMessageChunk[];

  const result = await consume(chunks);
  expect(result.output).toBe("");
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("search succeeded");
  expect(result.stderr).toContain("readFile failed");
  expect(result.stderr).toContain("writeFile failed");
  expect(result.stderr).toContain("unknown denied");
  expect(result.stderr).toContain("[REDACTED]");
  expect(result.stderr).not.toContain("secret");

  const off = await consume(chunks, { toolOutput: "off" });
  expect(off.stderr).not.toContain("search succeeded");
  expect(off.stderr).toContain("readFile failed");
});

test("manual approval is reported after the stream without a decision", async () => {
  let stderr = "";
  await expect(
    consumeSessionStream({
      buffered: true,
      now: () => 0,
      sessionId: "ss_AAAAAAAAAAAAAAAA",
      stderr: (text) => {
        stderr += text;
      },
      stdout: () => undefined,
      stream: chunkStream([
        {
          type: "tool-approval-request",
          approvalId: "approval-1",
          toolCallId: "unknown",
        },
        { type: "finish", finishReason: "tool-calls" },
      ]),
      toolOutput: "summary",
    })
  ).rejects.toEqual(
    new RunOperationalError("The Turn requires human approval.")
  );
  expect(stderr).toContain("approval-1 tool=unknown");
  expect(stderr).toContain("input=undefined");
});

test.each([
  [[{ type: "error", errorText: "stream failed" }], "stream failed"],
  [[{ type: "abort", reason: "stopped" }], "stopped"],
  [[{ type: "abort" }], "The Turn was aborted."],
  [[{ type: "finish", finishReason: "error" }], "failed during generation"],
  [[{ type: "start", messageId: "only" }], "ended before the Turn finished"],
] as const)(
  "Session failure chunks become operational errors",
  async (chunks, message) => {
    await expect(
      consume([...chunks] as BlazingAgentsUIMessageChunk[])
    ).rejects.toThrow(message);
  }
);
