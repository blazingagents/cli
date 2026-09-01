import { Readable, Writable } from "node:stream";
import { expect, test } from "vitest";
import {
  ApprovalInputInterruptedError,
  readApprovalDecision,
  readHiddenInput,
} from "./prompts.ts";

const INTERACTIVE_TERMINAL_ERROR = /interactive terminal/;
const MASK_GLYPHS = /[*•▪]/;

class MockTtyInput extends Readable {
  isTTY = true;

  setRawMode() {
    return this;
  }

  _read() {
    // Intentionally empty.
  }

  send(text: string) {
    this.push(Buffer.from(text));
  }

  sendChunk(chunk: string | Buffer) {
    this.push(chunk);
  }
}

class MockOutput extends Writable {
  data = "";

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error) => void
  ) {
    this.data += chunk.toString();
    callback();
  }
}

const asInput = (input: MockTtyInput) => input as unknown as NodeJS.ReadStream;
const asOutput = (output: MockOutput) =>
  output as unknown as Writable & { columns?: number };

test("hidden input rejects non-TTY input", async () => {
  const input = new MockTtyInput();
  input.isTTY = false;

  await expect(readHiddenInput("Key: ", asInput(input))).rejects.toThrow(
    "Interactive terminal input is required."
  );
});

test("hidden input reads a secret without echoing it", async () => {
  const input = new MockTtyInput();
  const output = new MockOutput();
  const result = readHiddenInput("Key: ", asInput(input), asOutput(output));
  setTimeout(() => input.send("ba_secret\r"), 20);

  await expect(result).resolves.toBe("ba_secret");
  expect(output.data).not.toContain("ba_secret");
  expect(output.data).not.toMatch(MASK_GLYPHS);
});

test("hidden input treats Ctrl+C as cancellation", async () => {
  const input = new MockTtyInput();
  const result = readHiddenInput("Key: ", asInput(input));
  setTimeout(() => input.send("\x03"), 20);

  await expect(result).rejects.toThrow("Input cancelled.");
});

test("hidden input treats Ctrl+D as cancellation", async () => {
  const input = new MockTtyInput();
  const result = readHiddenInput("Key: ", asInput(input));
  setTimeout(() => input.send("\x04"), 20);

  await expect(result).rejects.toThrow("Input cancelled.");
});

test("hidden input treats Escape as cancellation", async () => {
  const input = new MockTtyInput();
  const result = readHiddenInput("Key: ", asInput(input));
  setTimeout(() => input.send("\x1b"), 20);

  await expect(result).rejects.toThrow("Input cancelled.");
});

test.each([
  ["y", true, "Approved"],
  ["Y", true, "Approved"],
  ["n", false, "Denied"],
  ["N", false, "Denied"],
] as const)("approval input settles %s", async (key, decision, label) => {
  const input = new MockTtyInput();
  const output = new MockOutput();
  const result = readApprovalDecision(
    "Approve? y/n ",
    asInput(input),
    asOutput(output)
  );
  setTimeout(() => input.send(key), 20);

  await expect(result).resolves.toBe(decision);
  expect(output.data).toContain(label);
});

test("approval input treats bare Enter as denied", async () => {
  const input = new MockTtyInput();
  const output = new MockOutput();
  const result = readApprovalDecision(
    "Approve? y/n ",
    asInput(input),
    asOutput(output)
  );
  setTimeout(() => input.send("\r"), 20);

  await expect(result).resolves.toBe(false);
  expect(output.data).toContain("Denied");
});

test("approval input treats Escape as interruption", async () => {
  const input = new MockTtyInput();
  const result = readApprovalDecision("Approve? y/n ", asInput(input));
  setTimeout(() => input.send("\x1b"), 20);

  await expect(result).rejects.toBeInstanceOf(ApprovalInputInterruptedError);
});

/** Accepted residual behavior: clack confirm toggles on space and arrows. */
test.each([" \r", "\x1b[C\r"] as const)(
  "approval input accepts clack toggle sequence %j",
  async (keys) => {
    const input = new MockTtyInput();
    const result = readApprovalDecision("Approve? y/n ", asInput(input));
    setTimeout(() => input.send(keys), 20);

    await expect(result).resolves.toBe(true);
  }
);

test("approval input treats Ctrl+D as interruption", async () => {
  const input = new MockTtyInput();
  input.setEncoding("utf8");
  const result = readApprovalDecision("Approve? y/n ", asInput(input));
  setTimeout(() => input.sendChunk("\x04"), 20);

  await expect(result).rejects.toBeInstanceOf(ApprovalInputInterruptedError);
});

test("approval input rejects non-TTY input", async () => {
  const input = new MockTtyInput();
  input.isTTY = false;

  await expect(
    readApprovalDecision("Approve? y/n ", asInput(input))
  ).rejects.toThrow(INTERACTIVE_TERMINAL_ERROR);
});

test("approval input treats Ctrl+C as interruption", async () => {
  const input = new MockTtyInput();
  const result = readApprovalDecision("Approve? y/n ", asInput(input));
  setTimeout(() => input.send("\x03"), 20);

  await expect(result).rejects.toBeInstanceOf(ApprovalInputInterruptedError);
});
