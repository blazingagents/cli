import { expect, test } from "vitest";
import {
  abortedTurnRequests,
  apiBaseUrl,
  apiRequests,
  releaseAgent,
  runBinary,
  runBinaryInPty,
  sessionId,
} from "./packed-consumer.fixture.ts";

test("packed ba chat renders the hosted Turn through the upstream TUI and prints a materialized receipt", async () => {
  apiRequests.length = 0;
  const result = await runBinaryInPty(
    ["--base-url", `${apiBaseUrl}/chat-success`, "chat", "Release Agent"],
    String.raw`
expect -exact {Waiting for input...}
send -- {Show hosted features}
expect -exact {Show hosted features}
send -- "\r"
expect -exact {Hosted Session answer}
expect -exact {┌ Input}
send -- "\033"
`,
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Packed PTY exited ${result.exitCode}. stderr=${JSON.stringify(result.stderr)} output=${JSON.stringify(result.output)}`
    );
  }
  expect(result.stderr).toBe("");
  expect(result.output).toContain("Reasoning");
  expect(result.output).toContain("Tool · search");
  expect(result.output).toContain("Hosted Session answer");
  expect(result.output).toContain("4 tokens");
  expect(result.output).toContain(
    `Agent:   Release Agent (${releaseAgent.id})\r\nSession: ${sessionId}\r\nUsage:   12 input + 4 output tokens\r\nResume:  ba chat ${releaseAgent.id} --session ${sessionId}`
  );
  expect(apiRequests.map(({ method, url }) => ({ method, url }))).toEqual([
    { method: "GET", url: "/chat-success/v1/agents" },
    {
      method: "POST",
      url: "/chat-success/v1/agents/ag_AAAAAAAAAAAAAAAA/sessions",
    },
  ]);
  expect(apiRequests.at(-1)?.body).toMatchObject({
    message: {
      parts: [{ text: "Show hosted features", type: "text" }],
      role: "user",
    },
    trigger: "submit-message",
  });
});

test("packed ba chat restores the terminal and reports a typed pre-stream failure safely", async () => {
  apiRequests.length = 0;
  const result = await runBinaryInPty(
    ["--base-url", `${apiBaseUrl}/chat-pre-stream`, "chat", "Release Agent"],
    String.raw`
expect -exact {Waiting for input...}
send -- {exceed quota}
expect -exact {exceed quota}
send -- "\r"
`,
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
  );

  expect(result.exitCode).toBe(1);
  expect(result.output).toContain("Chat quota exceeded");
  expect(result.output).toContain("\x1b[?25h\x1b[?1049l");
  expect(result.output).not.toContain("at executeChat");
  expect(result.output).not.toContain("Resume:");
  expect(apiRequests.filter(({ method }) => method === "POST")).toHaveLength(1);
});

test("packed ba chat returns from an in-stream failure and resumes the admitted Session", async () => {
  apiRequests.length = 0;
  const result = await runBinaryInPty(
    ["--base-url", `${apiBaseUrl}/chat-error-retry`, "chat", "Release Agent"],
    String.raw`
expect -exact {Waiting for input...}
send -- {first prompt}
expect -exact {first prompt}
send -- "\r"
expect -exact {Safe streamed failure}
expect -exact {┌ Input}
send -- {retry prompt}
expect -exact {retry prompt}
send -- "\r"
expect -exact {Hosted Session answer}
expect -exact {┌ Input}
send -- "\033"
`,
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.output).toContain("Safe streamed failure");
  expect(result.output).toContain(
    `Usage:   12 input + 4 output tokens\r\nResume:  ba chat ${releaseAgent.id} --session ${sessionId}`
  );
  const turnRequests = apiRequests.filter(({ method }) => method === "POST");
  expect(turnRequests.map(({ url }) => url)).toEqual([
    "/chat-error-retry/v1/agents/ag_AAAAAAAAAAAAAAAA/sessions",
    `/chat-error-retry/v1/agents/ag_AAAAAAAAAAAAAAAA/sessions/${sessionId}`,
  ]);
  expect(turnRequests.map(({ body }) => body)).toMatchObject([
    { message: { parts: [{ text: "first prompt" }] } },
    { message: { parts: [{ text: "retry prompt" }] } },
  ]);
});

test("packed ba chat verifies and resumes the exact Agent-owned Session", async () => {
  apiRequests.length = 0;
  const result = await runBinaryInPty(
    [
      "--base-url",
      `${apiBaseUrl}/chat-success`,
      "chat",
      releaseAgent.id,
      "--session",
      sessionId,
    ],
    String.raw`
expect -exact {Waiting for input...}
send -- {resume exactly}
expect -exact {resume exactly}
send -- "\r"
expect -exact {Hosted Session answer}
expect -exact {┌ Input}
send -- "\033"
`,
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
  );

  expect(result.exitCode).toBe(0);
  expect(result.output).toContain(
    `Resume:  ba chat ${releaseAgent.id} --session ${sessionId}`
  );
  expect(apiRequests.map(({ method, url }) => ({ method, url }))).toEqual([
    { method: "GET", url: "/chat-success/v1/agents" },
    {
      method: "GET",
      url: `/chat-success/v1/agents/${releaseAgent.id}/sessions/${sessionId}/messages?limit=1`,
    },
    {
      method: "POST",
      url: `/chat-success/v1/agents/${releaseAgent.id}/sessions/${sessionId}`,
    },
  ]);
});

test("packed ba chat aborts an active Turn through the SDK while an idle exit succeeds", async () => {
  apiRequests.length = 0;
  abortedTurnRequests.length = 0;
  const result = await runBinaryInPty(
    ["--base-url", `${apiBaseUrl}/chat-cancel`, "chat", "Release Agent"],
    String.raw`
expect -exact {Waiting for input...}
send -- {wait for cancellation}
expect -exact {wait for cancellation}
send -- "\r"
expect -exact {Streaming...}
send -- "\003"
`,
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
  );

  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("Interrupted");
  expect(result.output).toContain(
    `Resume:  ba chat ${releaseAgent.id} --session ${sessionId}`
  );
  await expect
    .poll(
      () =>
        abortedTurnRequests.includes(
          "/chat-cancel/v1/agents/ag_AAAAAAAAAAAAAAAA/sessions"
        ),
      { timeout: 5000 }
    )
    .toBe(true);
  expect(apiRequests.filter(({ method }) => method === "POST")).toHaveLength(1);
});

test("packed ba chat rejects Admin, ambiguous, and foreign Session selection before the TUI", async () => {
  const authentication = {
    BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}`,
  };
  const admin = await runBinaryInPty(
    ["--base-url", `${apiBaseUrl}/admin`, "chat", "Admin Agent"],
    "",
    authentication
  );
  expect(admin.exitCode).toBe(1);
  expect(admin.output).toContain("Use ba assist instead");
  expect(admin.output).not.toContain("\x1b[?1049h");

  const ambiguous = await runBinaryInPty(
    ["--base-url", `${apiBaseUrl}/ambiguous`, "chat", "RELEASE AGENT"],
    "",
    authentication
  );
  expect(ambiguous.exitCode).toBe(1);
  expect(ambiguous.output).toContain('Agent name "RELEASE AGENT" is ambiguous');
  expect(ambiguous.output).toContain("Release Agent (ag_AAAAAAAAAAAAAAAA)");
  expect(ambiguous.output).toContain("release agent (ag_BBBBBBBBBBBBBBBB)");

  apiRequests.length = 0;
  const foreign = await runBinaryInPty(
    [
      "--base-url",
      `${apiBaseUrl}/missing-session`,
      "chat",
      "Release Agent",
      "--session",
      sessionId,
    ],
    "",
    authentication
  );
  expect(foreign.exitCode).toBe(1);
  expect(foreign.output).toContain("Session not found");
  expect(foreign.output).not.toContain("\x1b[?1049h");
  expect(apiRequests.some(({ method }) => method === "POST")).toBe(false);
});

test("packed ba chat rejects non-TTY use before credentials or API calls", async () => {
  apiRequests.length = 0;
  const result = await runBinary([
    "--base-url",
    `${apiBaseUrl}/chat-non-tty`,
    "chat",
    "Release Agent",
  ]);

  expect(result).toEqual({
    exitCode: 1,
    stderr:
      "Chat requires an interactive terminal on stdin and stdout. Use ba run for non-interactive input.\n",
    stdout: "",
  });
  expect(apiRequests).toEqual([]);
});

test("packed ba assist rejects non-TTY use before credentials or API calls", async () => {
  apiRequests.length = 0;
  const result = await runBinary([
    "--base-url",
    `${apiBaseUrl}/assist-non-tty`,
    "assist",
  ]);

  expect(result).toEqual({
    exitCode: 1,
    stderr:
      "BA Assist requires an interactive terminal on stdin and stdout. Use ba run for non-interactive input.\n",
    stdout: "",
  });
  expect(apiRequests).toEqual([]);
});
