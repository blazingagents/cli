import { readFile } from "node:fs/promises";
import type { z } from "zod";
import {
  jsonSchemaShapeSchema,
  metadataSchema,
  type PromptVariables,
} from "./contracts.ts";

const PROMPT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class RunInvocationError extends Error {
  override name = "RunInvocationError";
}

export interface RawRunCommandOptions {
  json?: boolean;
  metadata?: Record<string, unknown>;
  prompt?: string;
  promptId?: string;
  schema?: string;
  session?: string;
  toolOutput: "off" | "summary";
  userId?: string;
  var?: Record<string, string>;
}

type RunPrompt =
  | { kind: "literal"; prompt: string }
  | { kind: "stored"; promptId: string; variables: PromptVariables };

type RunSchema = z.infer<typeof jsonSchemaShapeSchema>;

export type RunExecutionMode =
  | { json: boolean; mode: "stateless" }
  | { json: boolean; mode: "session"; sessionId: string }
  | { mode: "schema"; schema: RunSchema };

export type RunCommandOptions = RunPrompt &
  RunExecutionMode & {
    metadata: Record<string, unknown>;
    toolOutput: "off" | "summary";
    userId: string;
  };

export function parseMetadata(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new RunInvocationError("--metadata must be a JSON object.", {
      cause: error,
    });
  }
  const result = metadataSchema.safeParse(parsed);
  if (!result.success) {
    throw new RunInvocationError("--metadata must be a JSON object.");
  }
  return result.data;
}

export function collectPromptVariable(
  value: string,
  previous: Record<string, string> = {}
): Record<string, string> {
  const separator = value.indexOf("=");
  const key = separator < 0 ? "" : value.slice(0, separator);
  if (!PROMPT_VARIABLE_NAME.test(key)) {
    throw new RunInvocationError(
      "--var must use key=value with a valid Prompt variable name."
    );
  }
  if (Object.hasOwn(previous, key)) {
    throw new RunInvocationError(
      `Prompt variable "${key}" was supplied more than once.`
    );
  }
  return { ...previous, [key]: value.slice(separator + 1) };
}

async function readSchema(path: string): Promise<RunSchema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new RunInvocationError(`Unable to read a JSON Schema from ${path}.`, {
      cause: error,
    });
  }
  const result = jsonSchemaShapeSchema.safeParse(parsed);
  if (!result.success) {
    throw new RunInvocationError(`Invalid JSON Schema in ${path}.`);
  }
  return result.data;
}

export async function prepareRunOptions({
  options,
  stdin,
}: {
  options: RawRunCommandOptions;
  stdin?: string;
}): Promise<RunCommandOptions> {
  const literalPrompt = options.prompt;
  const promptId = options.promptId;
  const schemaPath = options.schema;
  const sessionId = options.session;
  const literalSpecified = literalPrompt !== undefined;
  const stdinSpecified = stdin !== undefined && stdin.trim().length > 0;
  const storedPromptSpecified = promptId !== undefined;
  const schemaSpecified = schemaPath !== undefined;
  const sessionSpecified = sessionId !== undefined;
  const sourceCount =
    Number(literalSpecified) +
    Number(stdinSpecified) +
    Number(storedPromptSpecified);
  if (sourceCount !== 1) {
    throw new RunInvocationError(
      "Exactly one non-empty prompt source is required."
    );
  }
  if (literalSpecified && literalPrompt.trim().length === 0) {
    throw new RunInvocationError("--prompt must not be empty.");
  }
  if (
    options.var &&
    Object.keys(options.var).length > 0 &&
    !storedPromptSpecified
  ) {
    throw new RunInvocationError("--var requires --prompt-id.");
  }
  let mode: RunExecutionMode = {
    json: Boolean(options.json),
    mode: "stateless",
  };
  if (schemaSpecified) {
    mode = { mode: "schema", schema: await readSchema(schemaPath) };
  } else if (sessionSpecified) {
    mode = { json: Boolean(options.json), mode: "session", sessionId };
  }
  const common = {
    metadata: options.metadata ?? {},
    ...mode,
    toolOutput: options.toolOutput,
    userId: options.userId ?? "",
  };
  if (storedPromptSpecified) {
    return {
      ...common,
      kind: "stored",
      promptId,
      variables: options.var ?? {},
    };
  }
  return {
    ...common,
    kind: "literal",
    prompt: literalPrompt ?? (stdin as string),
  };
}

export function validatePromptVariables(
  expected: readonly string[],
  supplied: Record<string, string>
) {
  const missing = expected.filter((key) => !Object.hasOwn(supplied, key));
  const extra = Object.keys(supplied).filter((key) => !expected.includes(key));
  if (missing.length === 0 && extra.length === 0) {
    return;
  }
  const details = [
    missing.length > 0 ? `missing: ${missing.join(", ")}` : "",
    extra.length > 0 ? `unknown: ${extra.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  throw new RunInvocationError(`Invalid Prompt variables (${details}).`);
}
