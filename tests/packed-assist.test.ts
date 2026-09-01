import { expect, test } from "vitest";
import {
  adminAgent,
  apiBaseUrl,
  apiRequests,
  detachedApprovalContinuations,
  runBinaryInPty,
  sessionId,
} from "./packed-consumer.fixture.ts";

test("packed ba assist renders an unapproved read and prints its Session receipt", async () => {
  apiRequests.length = 0;
  const result = await runBinaryInPty(
    ["--base-url", `${apiBaseUrl}/assist-read`, "assist"],
    String.raw`
expect -exact {Waiting for input...}
send -- {Inspect tenant settings}
expect -exact {Inspect tenant settings}
send -- "\r"
expect -exact {Tool · tenant}
expect -exact {Tenant settings loaded.}
expect -exact {┌ Input}
send -- "\033"
`,
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
  );
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("Tenant settings loaded.");
  expect(result.output).toContain(
    `Session: ${sessionId}\r\nResume:  ba assist --session ${sessionId}`
  );
  expect(apiRequests.some(({ url }) => url.includes("/tool-approvals/"))).toBe(
    false
  );
});

test("packed ba assist submits live approval and denial decisions only", async () => {
  for (const [scenario, key, expectedBody, expectedText] of [
    ["assist-live-approve", "y", { approved: true }, "Mutation settled once."],
    ["assist-live-approve", "Y", { approved: true }, "Mutation settled once."],
    ["assist-live-deny", "n", { approved: false }, "Mutation denied safely."],
    ["assist-live-deny", "N", { approved: false }, "Mutation denied safely."],
  ] as const) {
    apiRequests.length = 0;
    const result = await runBinaryInPty(
      ["--base-url", `${apiBaseUrl}/${scenario}`, "assist"],
      String.raw`
expect -exact {Waiting for input...}
send -- {Mutate one Agent}
expect -exact {Mutate one Agent}
send -- "\r"
expect -exact {Approve tool agents? y/n}
send -- {${key}}
expect -exact {${expectedText}}
expect -exact {┌ Input}
send -- "\033"
`,
      { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('"action":');
    expect(result.output).toContain("ag_BBBBBBBBBBBBBBBB");
    expect(result.output).toContain(expectedText);
    expect(result.output).toContain(`Session: ${sessionId}`);
    const decisions = apiRequests.filter(
      ({ method, url }) => method === "POST" && url.includes("/tool-approvals/")
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.body).toEqual(expectedBody);
  }
});

test("packed ba assist persists multiple approvals sequentially and rereads stale state", async () => {
  apiRequests.length = 0;
  const multiple = await runBinaryInPty(
    ["--base-url", `${apiBaseUrl}/assist-live-multiple`, "assist"],
    String.raw`
expect -exact {Waiting for input...}
send -- {Mutate two Agents}
expect -exact {Mutate two Agents}
send -- "\r"
expect -exact {Approve tool agents? y/n}
send -- {y}
expect -exact {Approve tool agents? y/n}
send -- {n}
expect -exact {Mutation settled once.}
expect -exact {┌ Input}
send -- "\033"
`,
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
  );
  expect(multiple.exitCode).toBe(0);
  expect(
    apiRequests
      .filter(
        ({ method, url }) =>
          method === "POST" && url.includes("/tool-approvals/")
      )
      .map(({ body }) => body)
  ).toEqual([{ approved: true }, { approved: false }]);
  expect(
    apiRequests.filter(({ url }) =>
      url.includes("/tool-approval-continuations/")
    )
  ).toHaveLength(1);

  apiRequests.length = 0;
  const stale = await runBinaryInPty(
    ["--base-url", `${apiBaseUrl}/assist-live-stale`, "assist"],
    String.raw`
expect -exact {Waiting for input...}
send -- {Retry stale approval}
expect -exact {Retry stale approval}
send -- "\r"
expect -exact {Approve tool agents? y/n}
send -- {y}
expect -exact {Mutation settled once.}
expect -exact {┌ Input}
send -- "\033"
`,
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
  );
  expect(stale.exitCode).toBe(0);
  expect(
    apiRequests.map(({ method, url }) => ({ method, url }))
  ).toContainEqual({
    method: "GET",
    url: `/assist-live-stale/v1/agents/${adminAgent.id}/sessions/${sessionId}/tool-approvals`,
  });
});

test("packed ba assist recovers a pending approval before opening a clean TUI", async () => {
  apiRequests.length = 0;
  const result = await runBinaryInPty(
    [
      "--base-url",
      `${apiBaseUrl}/assist-recovery-approve`,
      "assist",
      "--session",
      sessionId,
    ],
    String.raw`
expect -exact {Pending Tool approval}
expect -exact {Recovered packed update}
expect -exact {Approve? y/n}
send -- {y}
expect -exact {Approved}
expect -exact {Mutation settled once.}
expect -exact {Waiting for input...}
send -- "\033"
`,
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
  );
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain(`Session: ${sessionId}`);
  expect(result.output).toContain(`Resume:  ba assist --session ${sessionId}`);
  expect(
    apiRequests.filter(
      ({ method, url }) => method === "POST" && url.includes("/tool-approvals/")
    )
  ).toHaveLength(1);
});

test("packed recovery interruption leaves pending state and admitted work detaches", async () => {
  apiRequests.length = 0;
  const beforeDecision = await runBinaryInPty(
    [
      "--base-url",
      `${apiBaseUrl}/assist-recovery-interrupt`,
      "assist",
      "--session",
      sessionId,
    ],
    String.raw`
expect -exact {Approve? y/n}
send -- "\003"
expect -exact {Resume:  ba assist --session ss_AAAAAAAAAAAAAAAA}
`,
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
  );
  expect(beforeDecision.exitCode).toBe(0);
  expect(
    apiRequests.some(
      ({ method, url }) => method === "POST" && url.includes("/tool-approvals/")
    )
  ).toBe(false);

  apiRequests.length = 0;
  detachedApprovalContinuations.length = 0;
  const detached = await runBinaryInPty(
    [
      "--base-url",
      `${apiBaseUrl}/assist-recovery-detach`,
      "assist",
      "--session",
      sessionId,
    ],
    String.raw`
expect -exact {Approve? y/n}
send -- {y}
expect -exact {Approved}
expect -exact {Continuation admitted.}
send -- "\003"
expect -exact {Resume:  ba assist --session ss_AAAAAAAAAAAAAAAA}
`,
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
  );
  expect(detached.exitCode).toBe(0);
  await expect
    .poll(() => detachedApprovalContinuations.length, { timeout: 5000 })
    .toBe(1);
  expect(
    apiRequests.filter(
      ({ method, url }) => method === "POST" && url.includes("/tool-approvals/")
    )
  ).toHaveLength(1);
});

test("packed recovery Ctrl+D leaves pending state without hanging", async () => {
  apiRequests.length = 0;
  const result = await runBinaryInPty(
    [
      "--base-url",
      `${apiBaseUrl}/assist-recovery-eof`,
      "assist",
      "--session",
      sessionId,
    ],
    String.raw`
expect -exact {Approve? y/n}
send -- "\004"
expect -exact {Resume:  ba assist --session ss_AAAAAAAAAAAAAAAA}
`,
    { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
  );
  expect(result.exitCode).toBe(0);
  expect(
    apiRequests.some(
      ({ method, url }) => method === "POST" && url.includes("/tool-approvals/")
    )
  ).toBe(false);
});

test("packed ba assist reports invariant, recovery, Session, and stream errors safely", async () => {
  const authentication = {
    BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}`,
  };
  for (const [scenario, expected] of [
    ["assist-zero", "found 0"],
    ["assist-multiple", "found 2"],
  ] as const) {
    const result = await runBinaryInPty(
      ["--base-url", `${apiBaseUrl}/${scenario}`, "assist"],
      "",
      authentication
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(expected);
    expect(result.output).not.toContain("\x1b[?1049h");
  }

  const foreign = await runBinaryInPty(
    [
      "--base-url",
      `${apiBaseUrl}/assist-foreign`,
      "assist",
      "--session",
      sessionId,
    ],
    "",
    authentication
  );
  expect(foreign.exitCode).toBe(1);
  expect(foreign.output).toContain("Session not found");
  expect(foreign.output).not.toContain("Resume:");

  const preStream = await runBinaryInPty(
    ["--base-url", `${apiBaseUrl}/assist-pre-stream`, "assist"],
    String.raw`
expect -exact {Waiting for input...}
send -- {exceed quota}
expect -exact {exceed quota}
send -- "\r"
`,
    authentication
  );
  expect(preStream.exitCode).toBe(1);
  expect(preStream.output).toContain("Assist quota exceeded");
  expect(preStream.output).not.toContain("at executeAssist");

  const recoveryError = await runBinaryInPty(
    [
      "--base-url",
      `${apiBaseUrl}/assist-recovery-error`,
      "assist",
      "--session",
      sessionId,
    ],
    `
expect -exact {Approve? y/n}
send -- {y}
expect -exact {Safe recovery failure}
`,
    authentication
  );
  expect(recoveryError.exitCode).toBe(1);
  expect(recoveryError.output).toContain(`Session: ${sessionId}`);
  expect(recoveryError.output).toContain("Safe recovery failure");
});
