import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  collectPromptVariable,
  parseMetadata,
  prepareRunOptions,
  RunInvocationError,
  validatePromptVariables,
} from "./run-input.ts";

const directories: string[] = [];
const promptId = "prompt_AAAAAAAAAAAAAAAA";
const sessionId = "ss_AAAAAAAAAAAAAAAA";
const baseOptions = { toolOutput: "summary" as const };

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

test("metadata parsing accepts only JSON objects", () => {
  expect(parseMetadata('{"job":"release"}')).toEqual({ job: "release" });
  expect(() => parseMetadata("not json")).toThrow(
    new RunInvocationError("--metadata must be a JSON object.")
  );
  expect(() => parseMetadata("[]")).toThrow(
    new RunInvocationError("--metadata must be a JSON object.")
  );
});

test("Prompt variables use strict unique key=value syntax", () => {
  expect(collectPromptVariable("version=1=2")).toEqual({ version: "1=2" });
  expect(collectPromptVariable("environment=", { version: "1" })).toEqual({
    environment: "",
    version: "1",
  });
  for (const value of ["missing-separator", "1bad=value", "bad-name=value"]) {
    expect(() => collectPromptVariable(value)).toThrow(
      "--var must use key=value"
    );
  }
  expect(() => collectPromptVariable("version=2", { version: "1" })).toThrow(
    'Prompt variable "version" was supplied more than once.'
  );
});

test("prompt preparation selects literal, stdin, and stored Prompt inputs", async () => {
  await expect(
    prepareRunOptions({
      options: { ...baseOptions, json: true, prompt: "literal", userId: "u" },
    })
  ).resolves.toEqual({
    json: true,
    kind: "literal",
    metadata: {},
    mode: "stateless",
    prompt: "literal",
    toolOutput: "summary",
    userId: "u",
  });
  await expect(
    prepareRunOptions({ options: baseOptions, stdin: "stdin\n" })
  ).resolves.toMatchObject({ kind: "literal", prompt: "stdin\n", userId: "" });
  await expect(
    prepareRunOptions({
      options: {
        ...baseOptions,
        promptId,
        session: sessionId,
        var: { version: "1" },
      },
    })
  ).resolves.toMatchObject({
    kind: "stored",
    mode: "session",
    promptId,
    sessionId,
    variables: { version: "1" },
  });
  await expect(
    prepareRunOptions({ options: { ...baseOptions, promptId } })
  ).resolves.toMatchObject({ variables: {} });
});

test.each([
  ["missing source", baseOptions, undefined, "Exactly one"],
  [
    "conflicting sources",
    { ...baseOptions, prompt: "one" },
    "two",
    "Exactly one",
  ],
  [
    "empty literal",
    { ...baseOptions, prompt: "   " },
    undefined,
    "must not be empty",
  ],
  [
    "orphan variable",
    { ...baseOptions, prompt: "one", var: { x: "1" } },
    undefined,
    "requires --prompt-id",
  ],
  [
    "empty schema path",
    { ...baseOptions, prompt: "one", schema: "" },
    undefined,
    "Unable to read",
  ],
] as const)(
  "prompt preparation rejects %s",
  async (_name, options, stdin, message) => {
    await expect(prepareRunOptions({ options, stdin })).rejects.toThrow(
      message
    );
  }
);

test("schema preparation reads and validates the official JSON Schema shape", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ba-schema-"));
  directories.push(directory);
  const valid = join(directory, "valid.json");
  const malformed = join(directory, "malformed.json");
  const unsupported = join(directory, "unsupported.json");
  await Promise.all([
    writeFile(
      valid,
      '{"type":"object","properties":{"ok":{"type":"boolean"}}}'
    ),
    writeFile(malformed, "{"),
    writeFile(unsupported, "{}"),
  ]);

  await expect(
    prepareRunOptions({
      options: { ...baseOptions, prompt: "one", schema: valid },
    })
  ).resolves.toMatchObject({
    mode: "schema",
    schema: { properties: { ok: { type: "boolean" } }, type: "object" },
  });
  for (const [path, message] of [
    [join(directory, "missing.json"), "Unable to read"],
    [malformed, "Unable to read"],
    [unsupported, "Invalid JSON Schema"],
  ]) {
    await expect(
      prepareRunOptions({
        options: { ...baseOptions, prompt: "one", schema: path },
      })
    ).rejects.toThrow(message);
  }
});

test("stored Prompt variables must match both ways", () => {
  expect(
    validatePromptVariables(["a", "b"], { a: "1", b: "2" })
  ).toBeUndefined();
  expect(() => validatePromptVariables(["a", "b"], { a: "1" })).toThrow(
    "missing: b"
  );
  expect(() => validatePromptVariables(["a"], { a: "1", b: "2" })).toThrow(
    "unknown: b"
  );
  expect(() => validatePromptVariables(["a"], { b: "2" })).toThrow(
    "missing: a; unknown: b"
  );
});
