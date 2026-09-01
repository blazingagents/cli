import { expect, test } from "vitest";
import {
  abortedTurnRequests,
  apiBaseUrl,
  apiRequests,
  runBinary,
  runBinaryWithSignal,
  sessionId,
} from "./packed-consumer.fixture.ts";

test("ba run keeps bounded secret-safe Tool summaries on stderr", async () => {
  const commonArgs = [
    "run",
    "Release Agent",
    "--prompt",
    "Use tools",
    "--session",
    sessionId,
  ];
  const summary = await runBinary(
    ["--base-url", `${apiBaseUrl}/tools`, ...commonArgs],
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
  );
  expect(summary.exitCode).toBe(0);
  expect(summary.stdout).toBe("Session answer");
  expect(summary.stderr).toContain("[tool] search succeeded");
  expect(summary.stderr).toContain("[tool] readFile failed");
  expect(summary.stderr).toContain("[REDACTED]");
  expect(summary.stderr).not.toContain("never-print-this");
  expect(summary.stderr).not.toContain("also-secret");
  for (const line of summary.stderr.trim().split("\n")) {
    expect(line.length).toBeLessThanOrEqual(430);
  }

  const off = await runBinary(
    [
      "--base-url",
      `${apiBaseUrl}/tools-off`,
      ...commonArgs,
      "--tool-output",
      "off",
    ],
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
  );
  expect(off.exitCode).toBe(0);
  expect(off.stdout).toBe("Session answer");
  expect(off.stderr).not.toContain("search succeeded");
  expect(off.stderr).toContain("readFile failed");
});

test("ba run reports durable approval without deciding it", async () => {
  apiRequests.length = 0;
  const result = await runBinary(
    [
      "--base-url",
      `${apiBaseUrl}/approval`,
      "run",
      "Release Agent",
      "--prompt",
      "Mutate",
      "--session",
      sessionId,
      "--json",
    ],
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
  );

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Approval pending: approval-durable-1");
  expect(result.stderr).toContain(`session=${sessionId}`);
  expect(result.stderr).toContain("tool=agents");
  expect(result.stderr).toContain("[REDACTED]");
  expect(result.stderr).not.toContain("never-print-this");
  expect(apiRequests.some(({ url }) => url.includes("tool-approvals"))).toBe(
    false
  );
});

test("ba run rejects Admin Agent and ambiguous selection deterministically", async () => {
  const admin = await runBinary(
    [
      "--base-url",
      `${apiBaseUrl}/admin`,
      "run",
      "Admin Agent",
      "--prompt",
      "hello",
    ],
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
  );
  expect(admin).toEqual({
    exitCode: 1,
    stderr:
      "The Admin Agent is available only through BA Assist. Use ba assist instead.\n",
    stdout: "",
  });

  const ambiguous = await runBinary(
    [
      "--base-url",
      `${apiBaseUrl}/ambiguous`,
      "run",
      "RELEASE AGENT",
      "--prompt",
      "hello",
    ],
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
  );
  expect(ambiguous.exitCode).toBe(1);
  expect(ambiguous.stdout).toBe("");
  expect(ambiguous.stderr).toContain('Agent name "RELEASE AGENT" is ambiguous');
  expect(ambiguous.stderr).toContain("Release Agent (ag_AAAAAAAAAAAAAAAA)");
  expect(ambiguous.stderr).toContain("release agent (ag_BBBBBBBBBBBBBBBB)");
});

test("ba run emits a complete stateless JSON document only after success", async () => {
  const result = await runBinary(
    [
      "--base-url",
      `${apiBaseUrl}/json`,
      "run",
      "Release Agent",
      "--prompt",
      "hello",
      "--json",
    ],
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
  );
  expect(result).toEqual({
    exitCode: 0,
    stderr: "",
    stdout:
      '{"agent":{"id":"ag_AAAAAAAAAAAAAAAA","name":"Release Agent"},"output":"Hello from the Agent"}\n',
  });
  expect(result.stdout).not.toContain("sessionId");
});

test("ba run preserves plain partial text but keeps buffered failure stdout empty without retry", async () => {
  apiRequests.length = 0;
  const plain = await runBinary(
    [
      "--base-url",
      `${apiBaseUrl}/generation-failure`,
      "run",
      "Release Agent",
      "--prompt",
      "hello",
    ],
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
  );
  expect(plain.exitCode).toBe(1);
  expect(plain.stdout).toBe("partial");
  expect(plain.stderr).not.toBe("");
  expect(
    apiRequests.filter(
      ({ method, url }) => method === "POST" && url.endsWith("/generation")
    )
  ).toHaveLength(1);

  apiRequests.length = 0;
  const buffered = await runBinary(
    [
      "--base-url",
      `${apiBaseUrl}/generation-failure`,
      "run",
      "Release Agent",
      "--prompt",
      "hello",
      "--json",
    ],
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
  );
  expect(buffered.exitCode).toBe(1);
  expect(buffered.stdout).toBe("");
  expect(buffered.stderr).not.toBe("");
  expect(
    apiRequests.filter(
      ({ method, url }) => method === "POST" && url.endsWith("/generation")
    )
  ).toHaveLength(1);
});

test("ba run maps decoded stream failures without corrupting buffered stdout", async () => {
  const plain = await runBinary(
    [
      "--base-url",
      `${apiBaseUrl}/stream-error`,
      "run",
      "Release Agent",
      "--prompt",
      "hello",
      "--session",
      sessionId,
    ],
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
  );
  expect(plain).toEqual({
    exitCode: 1,
    stderr: "Safe streamed failure\n",
    stdout: "partial",
  });

  const buffered = await runBinary(
    [
      "--base-url",
      `${apiBaseUrl}/stream-error`,
      "run",
      "Release Agent",
      "--prompt",
      "hello",
      "--session",
      sessionId,
      "--json",
    ],
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
  );
  expect(buffered).toEqual({
    exitCode: 1,
    stderr: "Safe streamed failure\n",
    stdout: "",
  });
});

test.each([
  ["SIGINT", 130, "signal-int"],
  ["SIGTERM", 143, "signal-term"],
] as const)(
  "ba run propagates %s through the SDK and exits %i",
  async (signal, exitCode, scenario) => {
    apiRequests.length = 0;
    abortedTurnRequests.length = 0;
    const result = await runBinaryWithSignal(
      [
        "--base-url",
        `${apiBaseUrl}/${scenario}`,
        "run",
        "Release Agent",
        "--prompt",
        "wait",
        "--json",
      ],
      signal,
      `/${scenario}/v1/agents/ag_AAAAAAAAAAAAAAAA/generation`,
      { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
    );

    expect(result.exitCode).toBe(exitCode);
    expect(result.stdout).toBe("");
    await expect
      .poll(() => abortedTurnRequests.some((url) => url.includes(scenario)))
      .toBe(true);
    expect(
      apiRequests.filter(
        ({ method, url }) => method === "POST" && url.endsWith("/generation")
      )
    ).toHaveLength(1);
  }
);
