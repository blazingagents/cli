import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Agent, BlazingAgentsUIMessageChunk } from "@blazingagents/sdk";
import { afterAll, beforeAll } from "vitest";
import type { UsageSummary } from "../src/contracts.ts";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryDirectories: string[] = [];
const SCENARIO_PATH = /^\/([^/]+)\/v1\//;

interface PackFile {
  path: string;
}

interface PackResult {
  filename: string;
  files: PackFile[];
}

let consumerDirectory: string;
let binaryPath: string;
let configHome: string;
let cliPack: PackResult;
let apiServer: Server;
let apiBaseUrl: string;
const apiRequests: Array<{ body: unknown; method: string; url: string }> = [];
const tenantRequests: Array<{
  authorization: string | undefined;
  method: string;
  url: string;
}> = [];
const packedTenantToken = `ba_${"p".repeat(40)}`;
const abortedTurnRequests: string[] = [];
const detachedApprovalContinuations: string[] = [];
const sessionId = "ss_AAAAAAAAAAAAAAAA";
const promptId = "prompt_AAAAAAAAAAAAAAAA";

const releaseAgent = {
  avatarUrl: null,
  createdAt: "2026-07-16T10:00:00.000Z",
  id: "ag_AAAAAAAAAAAAAAAA",
  instructions: "",
  mcpConnectionIds: [],
  memoryInjectionEnabled: false,
  metadata: {},
  model: "openrouter/test-model",
  name: "Release Agent",
  providerId: "prv_0123456789abcdef",
  workspaceId: "ws_AAAAAAAAAAAAAAAA",
  status: "active",
  tenantId: "ten_AAAAAAAAAAAAAAAA",
  tools: [],
  updatedAt: "2026-07-16T10:00:00.000Z",
  userId: "",
  version: 1,
} satisfies Agent;

const adminAgent = {
  ...releaseAgent,
  id: "ag_admAAAAAAAAAAAAA",
  name: "Admin Agent",
} satisfies Agent;

function chatUsage(): UsageSummary {
  return {
    agentId: releaseAgent.id,
    agentVersion: releaseAgent.version,
    commitId: "commit-chat-success",
    completedAt: "2026-07-16T10:00:01.000Z",
    durationMs: 1000,
    errorMessage: null,
    inputTokens: 12,
    modelDurationMs: 750,
    metadata: {},
    modelId: releaseAgent.model,
    outputTokens: 4,
    turnId: "turn_0123456789abcdef",
    sessionId,
    startedAt: "2026-07-16T10:00:00.000Z",
    status: "succeeded",
    stepUsages: [{ inputTokens: 12, outputTokens: 4, stepNumber: 0 }],
    tenantId: releaseAgent.tenantId,
    userId: "",
  };
}

function assistUsage(): UsageSummary {
  return {
    ...chatUsage(),
    agentId: adminAgent.id,
    commitId: "commit-assist-success",
    turnId: "turn_fedcba9876543210",
  };
}

function assistInitialChunks(scenario: string): BlazingAgentsUIMessageChunk[] {
  if (scenario === "assist-read") {
    return [
      { type: "start", messageId: "assistant-assist-read" },
      {
        type: "tool-input-available",
        input: { action: "get" },
        toolCallId: "call-assist-read",
        toolName: "tenant",
      },
      {
        output: { name: "Packed Tenant" },
        toolCallId: "call-assist-read",
        type: "tool-output-available",
      },
      { type: "text-start", id: "text-assist-read" },
      {
        type: "text-delta",
        id: "text-assist-read",
        delta: "Tenant settings loaded.",
      },
      { type: "text-end", id: "text-assist-read" },
      {
        type: "finish",
        finishReason: "stop",
        messageMetadata: { blazingAgents: { usage: assistUsage() } },
      },
    ];
  }
  const calls =
    scenario === "assist-live-multiple"
      ? [
          {
            approvalId: "approval-live-first",
            input: {
              action: "updateById",
              agentId: "ag_BBBBBBBBBBBBBBBB",
              changes: { name: "First packed update" },
            },
            toolCallId: "call-live-first",
          },
          {
            approvalId: "approval-live-second",
            input: {
              action: "deleteById",
              agentId: "ag_CCCCCCCCCCCCCCCC",
            },
            toolCallId: "call-live-second",
          },
        ]
      : [
          {
            approvalId: "approval-live-one",
            input: {
              action:
                scenario === "assist-live-deny" ? "deleteById" : "updateById",
              agentId: "ag_BBBBBBBBBBBBBBBB",
              ...(scenario === "assist-live-deny"
                ? {}
                : { changes: { name: "Packed approved update" } }),
            },
            toolCallId: "call-live-one",
          },
        ];
  return [
    { type: "start", messageId: "assistant-assist-approval" },
    ...calls.flatMap(({ approvalId, input, toolCallId }) => [
      {
        type: "tool-input-available" as const,
        input,
        toolCallId,
        toolName: "agents",
      },
      {
        type: "tool-approval-request" as const,
        approvalId,
        toolCallId,
      },
    ]),
    {
      type: "finish",
      finishReason: "stop",
      messageMetadata: { blazingAgents: { usage: assistUsage() } },
    },
  ];
}

function assistContinuationChunks(
  scenario: string
): BlazingAgentsUIMessageChunk[] {
  const denied = scenario === "assist-live-deny";
  return [
    { type: "start", messageId: "assistant-assist-approval" },
    ...(denied
      ? [
          {
            type: "tool-output-denied" as const,
            toolCallId: "call-live-one",
          },
        ]
      : [
          {
            type: "tool-output-available" as const,
            toolCallId:
              scenario === "assist-live-multiple"
                ? "call-live-first"
                : "call-live-one",
            output: { updated: true },
          },
        ]),
    { type: "text-start", id: "text-assist-continuation" },
    {
      type: "text-delta",
      id: "text-assist-continuation",
      delta: denied ? "Mutation denied safely." : "Mutation settled once.",
    },
    { type: "text-end", id: "text-assist-continuation" },
    { type: "finish", finishReason: "stop" },
  ];
}

function sessionChunks(scenario: string): BlazingAgentsUIMessageChunk[] {
  const finish = {
    type: "finish",
    finishReason: "stop",
  } satisfies BlazingAgentsUIMessageChunk;
  if (scenario === "chat-success" || scenario === "chat-error-retry") {
    return [
      { type: "start", messageId: "assistant-chat" },
      { type: "reasoning-start", id: "reasoning-chat" },
      {
        type: "reasoning-delta",
        id: "reasoning-chat",
        delta: "Checked the hosted context",
      },
      { type: "reasoning-end", id: "reasoning-chat" },
      {
        type: "tool-input-available",
        input: { query: "release" },
        toolCallId: "call-chat-search",
        toolName: "search",
      },
      {
        output: { count: 1 },
        toolCallId: "call-chat-search",
        type: "tool-output-available",
      },
      { type: "text-start", id: "text-chat" },
      {
        type: "text-delta",
        id: "text-chat",
        delta: "# Hosted Session answer",
      },
      { type: "text-end", id: "text-chat" },
      {
        type: "finish",
        finishReason: "stop",
        messageMetadata: { blazingAgents: { usage: chatUsage() } },
      },
    ];
  }
  if (scenario === "approval") {
    return [
      { type: "start", messageId: "assistant-approval" },
      {
        type: "tool-input-available",
        input: { action: "delete", apiKey: "never-print-this" },
        toolCallId: "call-approval",
        toolName: "agents",
      },
      {
        type: "tool-approval-request",
        approvalId: "approval-durable-1",
        toolCallId: "call-approval",
      },
      finish,
    ];
  }
  if (scenario === "stream-error") {
    return [
      { type: "start", messageId: "assistant-error" },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "partial" },
      { type: "error", errorText: "Safe streamed failure" },
    ];
  }
  if (scenario === "tools" || scenario === "tools-off") {
    return [
      { type: "start", messageId: "assistant-tools" },
      {
        type: "tool-input-start",
        toolCallId: "call-success",
        toolName: "search",
      },
      {
        type: "tool-input-available",
        input: {
          apiKey: "never-print-this",
          query: "x".repeat(300),
        },
        toolCallId: "call-success",
        toolName: "search",
      },
      {
        output: { count: 1, token: "also-secret" },
        toolCallId: "call-success",
        type: "tool-output-available",
      },
      {
        input: { path: "/safe/path" },
        toolCallId: "call-failure",
        toolName: "readFile",
        type: "tool-input-available",
      },
      {
        errorText: "File was unavailable",
        toolCallId: "call-failure",
        type: "tool-output-error",
      },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "Session answer" },
      { type: "text-end", id: "text-1" },
      finish,
    ];
  }
  return [
    { type: "start", messageId: "assistant-1" },
    { type: "text-start", id: "text-1" },
    { type: "text-delta", id: "text-1", delta: "Session answer" },
    { type: "text-end", id: "text-1" },
    finish,
  ];
}

async function pack(destination: string) {
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--json", "--pack-destination", destination, "."],
    { cwd: repositoryRoot }
  );
  const results = Object.values(
    JSON.parse(stdout) as Record<string, PackResult>
  );
  const [result] = results;
  if (!result) {
    throw new Error("npm pack returned no result for the CLI.");
  }
  return result;
}

function runBinary(
  args: string[],
  environment: NodeJS.ProcessEnv = {},
  input = ""
) {
  return new Promise<{ exitCode: number; stderr: string; stdout: string }>(
    (resolve, reject) => {
      const child = spawn(binaryPath, args, {
        cwd: consumerDirectory,
        env: {
          ...process.env,
          BLAZING_AGENTS_API_KEY: undefined,
          BLAZING_AGENTS_BASE_URL: undefined,
          CI: undefined,
          HOME: join(consumerDirectory, "home"),
          NO_COLOR: "1",
          XDG_CONFIG_HOME: configHome,
          ...environment,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => {
        resolve({ exitCode: code ?? 1, stderr, stdout });
      });
      child.stdin.end(input);
    }
  );
}

function runBinaryWithSignal(
  args: string[],
  signal: "SIGINT" | "SIGTERM",
  requestMarker: string,
  environment: NodeJS.ProcessEnv = {}
) {
  return new Promise<{ exitCode: number; stderr: string; stdout: string }>(
    (resolve, reject) => {
      const child = spawn(binaryPath, args, {
        cwd: consumerDirectory,
        env: {
          ...process.env,
          BLAZING_AGENTS_API_KEY: undefined,
          BLAZING_AGENTS_BASE_URL: undefined,
          CI: undefined,
          HOME: join(consumerDirectory, "home"),
          NO_COLOR: "1",
          XDG_CONFIG_HOME: configHome,
          ...environment,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      const timeout = setTimeout(() => {
        clearInterval(poll);
        child.kill("SIGKILL");
        reject(new Error(`Turn request ${requestMarker} did not start.`));
      }, 5000);
      const poll = setInterval(() => {
        if (apiRequests.some(({ url }) => url.includes(requestMarker))) {
          clearInterval(poll);
          clearTimeout(timeout);
          child.kill(signal);
        }
      }, 10);
      child.once("close", (code) => {
        clearInterval(poll);
        clearTimeout(timeout);
        resolve({ exitCode: code ?? 1, stderr, stdout });
      });
      child.stdin.end();
    }
  );
}

function tclQuote(value: string) {
  return `{${value.replaceAll("\\", "\\\\").replaceAll("{", "\\{").replaceAll("}", "\\}")}}`;
}

function runCommandInPty(
  command: string,
  args: string[],
  interaction: string,
  environment: NodeJS.ProcessEnv = {}
) {
  const commandLine = [command, ...args].map(tclQuote).join(" ");
  const expectProgram = `
set timeout 10
log_user 1
expect_before timeout { puts stderr {PTY interaction timed out}; exit 124 }
spawn -noecho ${commandLine}
stty rows 30 columns 120 < $spawn_out(slave,name)
${interaction}
expect eof
set processResult [wait]
exit [lindex $processResult 3]
`;
  const child = spawn("/usr/bin/expect", ["-c", expectProgram], {
    cwd: consumerDirectory,
    env: {
      ...process.env,
      BLAZING_AGENTS_API_KEY: undefined,
      BLAZING_AGENTS_BASE_URL: undefined,
      CI: undefined,
      HOME: join(consumerDirectory, "home"),
      TERM: "xterm-256color",
      XDG_CONFIG_HOME: configHome,
      ...environment,
    },
  });
  let output = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise<{ exitCode: number; output: string; stderr: string }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        resolve({ exitCode: code ?? 1, output, stderr });
      });
    }
  );
}

function runBinaryInPty(
  args: string[],
  interaction: string,
  environment: NodeJS.ProcessEnv = {}
) {
  return runCommandInPty(binaryPath, args, interaction, environment);
}

async function runHiddenPromptInPty(interaction: string) {
  const probePath = join(consumerDirectory, "login-prompt-probe.mjs");
  const promptsPath = pathToFileURL(
    join(
      consumerDirectory,
      "node_modules",
      "@blazingagents",
      "cli",
      "dist",
      "prompts.js"
    )
  ).href;
  await writeFile(
    probePath,
    `import { readHiddenInput } from ${JSON.stringify(promptsPath)};

try {
  const value = await readHiddenInput("Key: ");
  process.stdout.write(\`Length: \${value.length}\\n\`);
} catch (error) {
  process.stdout.write(\`\${error.message}\\n\`);
}
`
  );
  return runCommandInPty(process.execPath, [probePath], interaction);
}

beforeAll(async () => {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one explicit fake API owns the packed binary's scenario routing
  apiServer = createServer(async (request, response) => {
    let rawBody = "";
    for await (const chunk of request) {
      rawBody += chunk;
    }
    apiRequests.push({
      body: rawBody ? JSON.parse(rawBody) : undefined,
      method: request.method ?? "GET",
      url: request.url ?? "",
    });
    const url = request.url ?? "";
    const scenarioMatch = url.match(SCENARIO_PATH);
    const scenario = scenarioMatch?.[1] ?? "default";
    const apiPath = scenarioMatch ? url.slice(scenario.length + 1) : url;
    if (apiPath === "/v1/tenant") {
      tenantRequests.push({
        authorization: request.headers.authorization,
        method: request.method ?? "GET",
        url,
      });
      if (
        request.method !== "GET" ||
        request.headers.authorization !== `Bearer ${packedTenantToken}`
      ) {
        response.statusCode = 401;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            error: { code: "unauthorized", message: "Unauthorized" },
          })
        );
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ name: "Packed Tenant", quota: null }));
      return;
    }
    if (apiPath === "/v1/agents") {
      response.setHeader("content-type", "application/json");
      if (scenario === "assist-zero") {
        response.end(JSON.stringify({ agents: [releaseAgent] }));
      } else if (scenario === "assist-multiple") {
        response.end(
          JSON.stringify({ agents: [adminAgent, { ...adminAgent }] })
        );
      } else if (scenario.startsWith("assist-")) {
        response.end(JSON.stringify({ agents: [releaseAgent, adminAgent] }));
      } else if (scenario === "admin") {
        response.end(
          JSON.stringify({
            agents: [
              {
                ...releaseAgent,
                id: "ag_admAAAAAAAAAAAAA",
                name: "Admin Agent",
              },
            ],
          })
        );
      } else if (scenario === "ambiguous") {
        response.end(
          JSON.stringify({
            agents: [
              releaseAgent,
              {
                ...releaseAgent,
                id: "ag_BBBBBBBBBBBBBBBB",
                name: "release agent",
              },
            ],
          })
        );
      } else {
        response.end(JSON.stringify({ agents: [releaseAgent] }));
      }
      return;
    }
    if (apiPath === `/v1/prompts/${promptId}`) {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          createdAt: "2026-07-16T10:00:00.000Z",
          id: promptId,
          metadata: {},
          name: "Release",
          template: "Release {{version}} to {{environment}}",
          tenantId: "ten_AAAAAAAAAAAAAAAA",
          updatedAt: "2026-07-16T10:00:00.000Z",
          userId: "",
          variables: ["version", "environment"],
        })
      );
      return;
    }
    if (apiPath === "/v1/agents/ag_AAAAAAAAAAAAAAAA/generation") {
      response.setHeader("content-type", "text/plain; charset=utf-8");
      if (scenario === "schema" || scenario === "schema-invalid") {
        response.end(
          scenario === "schema" ? '{"answer":42}' : '{"answer":"wrong"}'
        );
      } else if (scenario === "generation-failure") {
        response.writeHead(200, { "content-length": "100" });
        response.write("partial");
        setImmediate(() => response.destroy(new Error("simulated failure")));
      } else if (scenario === "signal-int" || scenario === "signal-term") {
        response.write("partial");
        response.on("close", () => {
          if (!response.writableEnded) {
            abortedTurnRequests.push(url);
          }
        });
      } else {
        response.end("Hello from the Agent");
      }
      return;
    }
    if (
      apiPath ===
      `/v1/agents/ag_AAAAAAAAAAAAAAAA/sessions/${sessionId}/messages?limit=1`
    ) {
      if (scenario === "missing-session") {
        response.statusCode = 404;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            error: { code: "not_found", message: "Session not found" },
          })
        );
      } else {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({ data: [], latestCursor: null, nextCursor: null })
        );
      }
      return;
    }
    if (
      apiPath === "/v1/agents/ag_AAAAAAAAAAAAAAAA/sessions" &&
      request.method === "POST"
    ) {
      if (scenario === "chat-pre-stream") {
        response.statusCode = 429;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            error: { code: "quota_exceeded", message: "Chat quota exceeded" },
          })
        );
        return;
      }
      response.statusCode = 201;
      response.setHeader(
        "location",
        `/v1/agents/${releaseAgent.id}/sessions/${sessionId}`
      );
      response.setHeader("content-type", "text/event-stream");
      if (scenario === "chat-cancel") {
        response.write(
          `data: ${JSON.stringify({ type: "start", messageId: "assistant-cancel" })}\n\n`
        );
        response.write(
          `data: ${JSON.stringify({ type: "text-start", id: "text-cancel" })}\n\n`
        );
        response.on("close", () => {
          if (!response.writableEnded) {
            abortedTurnRequests.push(url);
          }
        });
        return;
      }
      const createChunks =
        scenario === "chat-error-retry" &&
        apiRequests.filter(
          ({ method, url: requestUrl }) =>
            method === "POST" &&
            requestUrl ===
              "/chat-error-retry/v1/agents/ag_AAAAAAAAAAAAAAAA/sessions"
        ).length === 1
          ? sessionChunks("stream-error")
          : sessionChunks(scenario);
      for (const chunk of createChunks) {
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      response.end("data: [DONE]\n\n");
      return;
    }
    if (
      apiPath === `/v1/agents/ag_AAAAAAAAAAAAAAAA/sessions/${sessionId}` &&
      request.method === "POST"
    ) {
      response.setHeader("content-type", "text/event-stream");
      for (const chunk of sessionChunks(scenario)) {
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      response.end("data: [DONE]\n\n");
      return;
    }
    if (
      apiPath ===
      `/v1/agents/${adminAgent.id}/sessions/${sessionId}/messages?limit=1`
    ) {
      if (scenario === "assist-foreign") {
        response.statusCode = 404;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            error: { code: "not_found", message: "Session not found" },
          })
        );
      } else {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({ data: [], latestCursor: null, nextCursor: null })
        );
      }
      return;
    }
    if (
      apiPath ===
        `/v1/agents/${adminAgent.id}/sessions/${sessionId}/tool-approvals` &&
      request.method === "GET"
    ) {
      const decisions = apiRequests.filter(
        ({ method, url: requestUrl }) =>
          method === "POST" &&
          requestUrl.startsWith(`/${scenario}/v1/agents/${adminAgent.id}`) &&
          requestUrl.includes("/tool-approvals/")
      );
      const approvalId = "approval-recovery-one";
      response.setHeader("content-type", "application/json");
      if (scenario === "assist-live-stale") {
        response.end(
          JSON.stringify({
            continuation: { id: "continuation-live", state: "succeeded" },
            data: [
              {
                approvalId: "approval-live-one",
                decision: "approved",
                input: { action: "updateById" },
                reason: null,
                toolCallId: "call-live-one",
                toolName: "agents",
              },
            ],
          })
        );
      } else {
        response.end(
          JSON.stringify({
            continuation:
              decisions.length > 0
                ? { id: "continuation-recovery", state: "queued" }
                : null,
            data: [
              {
                approvalId,
                decision: decisions.length > 0 ? "approved" : "pending",
                input: {
                  action: "updateById",
                  agentId: "ag_BBBBBBBBBBBBBBBB",
                  changes: { name: "Recovered packed update" },
                },
                reason: null,
                toolCallId: "call-live-one",
                toolName: "agents",
              },
            ],
          })
        );
      }
      return;
    }
    if (
      apiPath.startsWith(
        `/v1/agents/${adminAgent.id}/sessions/${sessionId}/tool-approvals/`
      ) &&
      request.method === "POST"
    ) {
      response.setHeader("content-type", "application/json");
      if (scenario === "assist-live-stale") {
        response.statusCode = 409;
        response.end(
          JSON.stringify({
            error: {
              code: "invalid_request",
              message: "Tool approval decision conflicts",
            },
          })
        );
      } else {
        const decisions = apiRequests.filter(
          ({ method, url: requestUrl }) =>
            method === "POST" &&
            requestUrl.startsWith(`/${scenario}/v1/agents/${adminAgent.id}`) &&
            requestUrl.includes("/tool-approvals/")
        ).length;
        response.statusCode = 202;
        response.end(
          JSON.stringify({
            continuationId: scenario.startsWith("assist-recovery")
              ? "continuation-recovery"
              : "continuation-live",
            state:
              scenario === "assist-live-multiple" && decisions === 1
                ? "waiting"
                : "queued",
          })
        );
      }
      return;
    }
    if (
      apiPath.startsWith(
        `/v1/agents/${adminAgent.id}/sessions/${sessionId}/tool-approval-continuations/`
      )
    ) {
      response.setHeader("content-type", "text/event-stream");
      if (scenario === "assist-recovery-detach") {
        response.write(
          [
            { type: "start", messageId: "assistant-assist-approval" },
            { type: "text-start", id: "text-admitted" },
            {
              type: "text-delta",
              id: "text-admitted",
              delta: "Continuation admitted.",
            },
          ]
            .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
            .join("")
        );
        response.on("close", () => {
          if (!response.writableEnded) {
            detachedApprovalContinuations.push(url);
          }
        });
        return;
      }
      const chunks =
        scenario === "assist-recovery-error"
          ? [{ type: "error" as const, errorText: "Safe recovery failure" }]
          : assistContinuationChunks(scenario);
      for (const chunk of chunks) {
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      response.end("data: [DONE]\n\n");
      return;
    }
    if (
      apiPath === `/v1/agents/${adminAgent.id}/sessions` &&
      request.method === "POST"
    ) {
      if (scenario === "assist-pre-stream") {
        response.statusCode = 429;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            error: {
              code: "quota_exceeded",
              message: "Assist quota exceeded",
            },
          })
        );
        return;
      }
      response.statusCode = 201;
      response.setHeader(
        "location",
        `/v1/agents/${adminAgent.id}/sessions/${sessionId}`
      );
      response.setHeader("content-type", "text/event-stream");
      for (const chunk of assistInitialChunks(scenario)) {
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      response.end("data: [DONE]\n\n");
      return;
    }
    response.statusCode = 404;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({ error: { code: "not_found", message: "Not found" } })
    );
  });
  await new Promise<void>((resolve) =>
    apiServer.listen(0, "127.0.0.1", resolve)
  );
  const address = apiServer.address() as AddressInfo;
  apiBaseUrl = `http://127.0.0.1:${address.port}`;

  const testDirectory = await mkdtemp(join(tmpdir(), "ba-packed-"));
  temporaryDirectories.push(testDirectory);
  const artifactsDirectory = join(testDirectory, "artifacts");
  consumerDirectory = join(testDirectory, "consumer");
  configHome = join(testDirectory, "config");
  await Promise.all([
    mkdir(artifactsDirectory),
    mkdir(consumerDirectory),
    mkdir(configHome),
  ]);

  cliPack = await pack(artifactsDirectory);

  await writeFile(
    join(consumerDirectory, "package.json"),
    JSON.stringify({
      dependencies: {
        "@blazingagents/cli": `file:${join(
          artifactsDirectory,
          cliPack.filename
        )}`,
      },
      name: "ba-packed-consumer",
      private: true,
      version: "1.0.0",
    })
  );
  const installEnvironment = { ...process.env };
  installEnvironment.npm_config_allow_scripts = undefined;
  installEnvironment.NPM_CONFIG_ALLOW_SCRIPTS = undefined;
  await execFileAsync("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: consumerDirectory,
    env: installEnvironment,
  });
  binaryPath = join(consumerDirectory, "node_modules", ".bin", "ba");
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    apiServer.close((error) => (error ? reject(error) : resolve()))
  );
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

export {
  abortedTurnRequests,
  adminAgent,
  apiBaseUrl,
  apiRequests,
  cliPack,
  configHome,
  consumerDirectory,
  detachedApprovalContinuations,
  promptId,
  releaseAgent,
  runBinary,
  runBinaryInPty,
  runBinaryWithSignal,
  runHiddenPromptInPty,
  sessionId,
  tenantRequests,
};
