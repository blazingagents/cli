import type { Writable } from "node:stream";
import { confirm, isCancel, password } from "@clack/prompts";

export class ApprovalInputInterruptedError extends Error {
  override name = "ApprovalInputInterruptedError";
}

type PromptInput = NodeJS.ReadStream;
type PromptOutput = Writable & { columns?: number };

function createEofAbort(input: PromptInput) {
  const controller = new AbortController();
  const onData = (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes.includes(4)) {
      controller.abort();
    }
  };
  input.on("data", onData);
  return {
    cleanup: () => input.off("data", onData),
    signal: controller.signal,
  };
}

export async function readHiddenInput(
  prompt: string,
  input: PromptInput = process.stdin,
  output: PromptOutput = process.stderr
): Promise<string> {
  if (!input.isTTY) {
    throw new Error("Interactive terminal input is required.");
  }
  const eofAbort = createEofAbort(input);
  let result: Awaited<ReturnType<typeof password>>;
  try {
    result = await password({
      input,
      mask: "",
      message: prompt,
      output,
      signal: eofAbort.signal,
    });
  } finally {
    eofAbort.cleanup();
  }
  if (isCancel(result)) {
    throw new Error("Input cancelled.");
  }
  return result;
}

export async function readApprovalDecision(
  prompt: string,
  input: PromptInput = process.stdin,
  output: PromptOutput = process.stdout
): Promise<boolean> {
  if (!input.isTTY) {
    throw new Error("Tool approval recovery requires an interactive terminal.");
  }
  const eofAbort = createEofAbort(input);
  let result: Awaited<ReturnType<typeof confirm>>;
  try {
    result = await confirm({
      active: "Approved",
      inactive: "Denied",
      initialValue: false,
      input,
      message: prompt,
      output,
      signal: eofAbort.signal,
    });
  } finally {
    eofAbort.cleanup();
  }
  if (isCancel(result)) {
    throw new ApprovalInputInterruptedError(
      "Tool approval recovery was interrupted."
    );
  }
  output.write(result ? "Approved\n" : "Denied\n");
  return result;
}
