import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  apiBaseUrl,
  apiRequests,
  consumerDirectory,
  promptId,
  runBinary,
  sessionId,
} from "./packed-consumer.fixture.ts";

test("ba run sends one literal stateless Turn and streams only assistant text", async () => {
  apiRequests.length = 0;

  const result = await runBinary(
    ["--base-url", apiBaseUrl, "run", "Release Agent", "--prompt", "Say hello"],
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
  );

  expect(result).toEqual({
    exitCode: 0,
    stderr: "",
    stdout: "Hello from the Agent",
  });
  expect(apiRequests).toEqual([
    { body: undefined, method: "GET", url: "/v1/agents" },
    {
      body: {
        metadata: {},
        output: { type: "text" },
        prompt: "Say hello",
        userId: "",
      },
      method: "POST",
      url: "/v1/agents/ag_AAAAAAAAAAAAAAAA/generation",
    },
  ]);
});

test("ba run accepts non-TTY stdin as the only literal prompt source", async () => {
  apiRequests.length = 0;

  const result = await runBinary(
    ["--base-url", `${apiBaseUrl}/stdin`, "run", "Release Agent"],
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` },
    "Prompt from stdin\n"
  );

  expect(result).toEqual({
    exitCode: 0,
    stderr: "",
    stdout: "Hello from the Agent",
  });
  expect(apiRequests.at(-1)).toMatchObject({
    body: {
      metadata: {},
      output: { type: "text" },
      prompt: "Prompt from stdin\n",
      userId: "",
    },
    method: "POST",
    url: "/stdin/v1/agents/ag_AAAAAAAAAAAAAAAA/generation",
  });
});

test("ba run validates stored Prompt variables and sends Attribution", async () => {
  apiRequests.length = 0;
  const result = await runBinary(
    [
      "--base-url",
      `${apiBaseUrl}/stored`,
      "run",
      "Release Agent",
      "--prompt-id",
      promptId,
      "--var",
      "version=1.2.3",
      "--var",
      "environment=production",
      "--user-id",
      "developer-42",
      "--metadata",
      '{"job":"release"}',
    ],
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
  );

  expect(result).toEqual({
    exitCode: 0,
    stderr: "",
    stdout: "Hello from the Agent",
  });
  expect(apiRequests.map(({ method, url }) => ({ method, url }))).toEqual([
    { method: "GET", url: "/stored/v1/agents" },
    { method: "GET", url: `/stored/v1/prompts/${promptId}` },
    {
      method: "POST",
      url: "/stored/v1/agents/ag_AAAAAAAAAAAAAAAA/generation",
    },
  ]);
  expect(apiRequests.at(-1)?.body).toEqual({
    metadata: { job: "release" },
    output: { type: "text" },
    promptId,
    userId: "developer-42",
    variables: { environment: "production", version: "1.2.3" },
  });
});

test("ba run rejects local prompt conflicts and malformed input before API access", async () => {
  for (const args of [
    [],
    ["--prompt", "   "],
    ["--prompt", "one", "--prompt-id", promptId],
    ["--var", "version=1"],
    ["--metadata", "[]", "--prompt", "hello"],
    ["--session", "bad-session", "--prompt", "hello"],
    ["--session", "", "--prompt", "hello"],
    ["--prompt-id", ""],
    ["--schema", "", "--prompt", "hello"],
  ]) {
    apiRequests.length = 0;
    const result = await runBinary(
      ["--base-url", `${apiBaseUrl}/invalid`, "run", "Release Agent", ...args],
      { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
    );
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error:");
    expect(result.stderr).toContain("Usage: ba run");
    expect(apiRequests).toEqual([]);
  }

  apiRequests.length = 0;
  const conflict = await runBinary(
    [
      "--base-url",
      `${apiBaseUrl}/invalid`,
      "run",
      "Release Agent",
      "--prompt",
      "flag prompt",
    ],
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` },
    "stdin prompt"
  );
  expect(conflict.exitCode).toBe(2);
  expect(conflict.stdout).toBe("");
  expect(conflict.stderr).toContain("Exactly one non-empty prompt source");
  expect(apiRequests).toEqual([]);
});

test("ba run rejects missing or extraneous stored Prompt variables before a Turn", async () => {
  for (const variables of [
    ["--var", "version=1.2.3"],
    [
      "--var",
      "version=1.2.3",
      "--var",
      "environment=production",
      "--var",
      "extra=value",
    ],
  ]) {
    apiRequests.length = 0;
    const result = await runBinary(
      [
        "--base-url",
        `${apiBaseUrl}/variables`,
        "run",
        "Release Agent",
        "--prompt-id",
        promptId,
        ...variables,
      ],
      { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
    );
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Invalid Prompt variables");
    expect(result.stderr).toContain("Usage: ba run");
    expect(apiRequests.some(({ method }) => method === "POST")).toBe(false);
  }
});

test("ba run schema mode validates the file and generated value before JSON output", async () => {
  const schemaPath = join(consumerDirectory, "answer.schema.json");
  await writeFile(
    schemaPath,
    JSON.stringify({
      additionalProperties: false,
      properties: { answer: { type: "number" } },
      required: ["answer"],
      type: "object",
    })
  );

  apiRequests.length = 0;
  const success = await runBinary(
    [
      "--base-url",
      `${apiBaseUrl}/schema`,
      "run",
      "Release Agent",
      "--prompt",
      "Give an answer",
      "--schema",
      schemaPath,
    ],
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
  );
  expect(success).toEqual({
    exitCode: 0,
    stderr: "",
    stdout:
      '{"agent":{"id":"ag_AAAAAAAAAAAAAAAA","name":"Release Agent"},"output":{"answer":42}}\n',
  });
  expect(apiRequests.at(-1)?.body).toMatchObject({
    output: {
      schema: {
        properties: { answer: { type: "number" } },
        type: "object",
      },
      type: "object",
    },
  });

  const invalidOutput = await runBinary(
    [
      "--base-url",
      `${apiBaseUrl}/schema-invalid`,
      "run",
      "Release Agent",
      "--prompt",
      "Give an answer",
      "--schema",
      schemaPath,
    ],
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
  );
  expect(invalidOutput.exitCode).toBe(1);
  expect(invalidOutput.stdout).toBe("");

  const malformedSchemaPath = join(consumerDirectory, "malformed.schema.json");
  await writeFile(malformedSchemaPath, "{}");
  apiRequests.length = 0;
  const malformedSchema = await runBinary(
    [
      "--base-url",
      `${apiBaseUrl}/schema`,
      "run",
      "Release Agent",
      "--prompt",
      "Give an answer",
      "--schema",
      malformedSchemaPath,
    ],
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
  );
  expect(malformedSchema.exitCode).toBe(2);
  expect(malformedSchema.stdout).toBe("");
  expect(apiRequests).toEqual([]);
});

test("ba run verifies and resumes only an explicit Session with immutable Attribution inputs", async () => {
  apiRequests.length = 0;
  const plain = await runBinary(
    [
      "--base-url",
      `${apiBaseUrl}/session`,
      "run",
      "Release Agent",
      "--prompt",
      "Continue",
      "--session",
      sessionId,
      "--user-id",
      "turn-user",
      "--metadata",
      '{"source":"ci"}',
    ],
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
  );

  expect(plain).toEqual({
    exitCode: 0,
    stderr: "",
    stdout: "Session answer",
  });
  expect(apiRequests.map(({ method, url }) => ({ method, url }))).toEqual([
    { method: "GET", url: "/session/v1/agents" },
    {
      method: "GET",
      url: `/session/v1/agents/ag_AAAAAAAAAAAAAAAA/sessions/${sessionId}/messages?limit=1`,
    },
    {
      method: "POST",
      url: `/session/v1/agents/ag_AAAAAAAAAAAAAAAA/sessions/${sessionId}`,
    },
  ]);
  expect(apiRequests.at(-1)?.body).toMatchObject({
    message: {
      parts: [{ text: "Continue", type: "text" }],
      role: "user",
    },
    metadata: { source: "ci" },
    userId: "turn-user",
  });

  const json = await runBinary(
    [
      "--base-url",
      `${apiBaseUrl}/session`,
      "run",
      "Release Agent",
      "--prompt",
      "Continue",
      "--session",
      sessionId,
      "--json",
    ],
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
  );
  expect(json).toEqual({
    exitCode: 0,
    stderr: "",
    stdout: `{"agent":{"id":"ag_AAAAAAAAAAAAAAAA","name":"Release Agent"},"output":"Session answer","sessionId":"${sessionId}"}\n`,
  });
});

test("ba run never falls back when explicit Session verification fails", async () => {
  apiRequests.length = 0;
  const result = await runBinary(
    [
      "--base-url",
      `${apiBaseUrl}/missing-session`,
      "run",
      "Release Agent",
      "--prompt",
      "Continue",
      "--session",
      sessionId,
    ],
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
  );

  expect(result).toEqual({
    exitCode: 1,
    stderr: "Session not found [code=not_found status=404]\n",
    stdout: "",
  });
  expect(apiRequests.some(({ method }) => method === "POST")).toBe(false);
  expect(apiRequests.some(({ url }) => url.endsWith("/generation"))).toBe(
    false
  );
});
