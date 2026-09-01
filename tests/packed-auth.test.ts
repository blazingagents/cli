import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import type { CliRuntime } from "../src/cli.ts";
import { credentialIdentifiers } from "../src/credentials.ts";
import { createCredentialStoreFixture } from "../src/test/credential-store-fixture.ts";
import {
  apiBaseUrl,
  apiRequests,
  consumerDirectory,
  runBinaryInPty,
  tenantRequests,
} from "./packed-consumer.fixture.ts";

const API_KEY = `ba_${"p".repeat(40)}`;
const STORAGE_FAILURE_KEY = `ba_${"s".repeat(40)}`;
const SECRET_METADATA_PATTERN = /key id|name:|fragment|expiry|token/i;
const BASE_URL_PATH_PATTERN = /\/[^/]+$/;

function packedLoginInteraction(dashboardUrl: string) {
  return String.raw`
expect -exact {${dashboardUrl}}
expect -exact {CLI API key}
after 100
send -- {${API_KEY}}
send -- "\r"
expect -re {Logged in to}
expect eof
`;
}

async function preparePackedLoginHarness() {
  const statePath = join(consumerDirectory, "packed-login-credentials.json");
  const loaderPath = join(consumerDirectory, "packed-login-keytar-loader.mjs");
  const loader = [
    'import { readFile, writeFile } from "node:fs/promises";',
    "export async function resolve(specifier, context, nextResolve) {",
    '  if (specifier === "@github/keytar") {',
    "    return { url: import.meta.url, shortCircuit: true };",
    "  }",
    "  return nextResolve(specifier, context);",
    "}",
    "const statePath = process.env.BA_TEST_CREDENTIAL_PATH;",
    'const key = (service, account) => service + "\\u0000" + account;',
    "async function readState() {",
    '  try { return JSON.parse(await readFile(statePath, "utf8")); }',
    '  catch (error) { if (error.code === "ENOENT") return {}; throw error; }',
    "}",
    "async function writeState(state) {",
    "  await writeFile(statePath, JSON.stringify(state));",
    "}",
    "export default {",
    "  async getPassword(service, account) {",
    "    const state = await readState();",
    "    return state[key(service, account)] ?? null;",
    "  },",
    "  async setPassword(service, account, password) {",
    "    const state = await readState();",
    "    state[key(service, account)] = password;",
    "    await writeState(state);",
    "  },",
    "  async deletePassword(service, account) {",
    "    const state = await readState();",
    "    const entryKey = key(service, account);",
    "    const existed = entryKey in state;",
    "    delete state[entryKey];",
    "    await writeState(state);",
    "    return existed;",
    "  },",
    "};",
  ].join("\n");
  await Promise.all([
    rm(statePath, { force: true }),
    writeFile(loaderPath, loader),
  ]);
  return {
    environment: {
      BA_TEST_CREDENTIAL_PATH: statePath,
      NODE_NO_WARNINGS: "1",
      NODE_OPTIONS: `--experimental-loader=${pathToFileURL(loaderPath).href}`,
    },
    statePath,
  };
}

test.runIf(process.platform !== "win32")(
  "the packed ba binary imports a dashboard key through a hidden PTY prompt",
  async () => {
    const harness = await preparePackedLoginHarness();
    const baseUrl = `${apiBaseUrl}/packed-pty-auth`;
    const loginArgs = ["--base-url", baseUrl, "--login"];
    const dashboardOrigin = baseUrl.replace(BASE_URL_PATH_PATTERN, "");
    const loginInteraction = packedLoginInteraction(
      `${dashboardOrigin}/app/keys`
    );
    apiRequests.length = 0;
    tenantRequests.length = 0;
    const first = await runBinaryInPty(
      loginArgs,
      loginInteraction,
      harness.environment
    );
    expect(first.exitCode).toBe(0);
    expect(first.output + first.stderr).not.toContain(API_KEY);
    expect(apiRequests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "GET", url: "/packed-pty-auth/v1/tenant" },
    ]);
    expect(tenantRequests).toEqual([
      {
        authorization: `Bearer ${API_KEY}`,
        method: "GET",
        url: "/packed-pty-auth/v1/tenant",
      },
    ]);
    const stored = JSON.parse(await readFile(harness.statePath, "utf8"));
    expect(Object.values(stored)).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain("apiKeyId");
    expect(JSON.stringify(stored)).not.toContain("expiresAt");

    apiRequests.length = 0;
    const repeated = await runBinaryInPty(
      loginArgs,
      `
after 1000
expect eof
`,
      harness.environment
    );
    expect(repeated.exitCode).toBe(0);
    expect(repeated.output + repeated.stderr).not.toContain(API_KEY);
    expect(repeated.output + repeated.stderr).not.toContain("/app/keys");
    expect(apiRequests).toEqual([]);
    expect(JSON.parse(await readFile(harness.statePath, "utf8"))).toEqual(
      stored
    );
  }
);

function loadPackedCli() {
  return import(
    pathToFileURL(
      join(
        consumerDirectory,
        "node_modules",
        "@blazingagents",
        "cli",
        "dist",
        "cli.js"
      )
    ).href
  );
}

async function runPackedAuth(
  args: string[],
  runtime: Partial<CliRuntime> & Pick<CliRuntime, "loadCredentialStore">
) {
  const { executeCli } = await loadPackedCli();
  let stdout = "";
  let stderr = "";
  const exitCode = await executeCli(args, {
    environment: {},
    homeDirectory: join(consumerDirectory, "home"),
    platform: process.platform,
    readSecret: async () => API_KEY,
    stderr: (text: string) => {
      stderr += text;
    },
    stdinIsTTY: true,
    stdout: (text: string) => {
      stdout += text;
    },
    version: "0.1.0",
    ...runtime,
  });
  return { exitCode, stderr, stdout };
}

test("packed auth imports a dashboard key in the safe order and repeats harmlessly", async () => {
  const store = createCredentialStoreFixture();
  const events: string[] = [];
  const result = await runPackedAuth(
    ["--base-url", `${apiBaseUrl}/packed-auth`, "--login"],
    {
      fetch: (input, init) => {
        events.push("network");
        return globalThis.fetch(input, init);
      },
      loadCredentialStore: store.loader,
      stderr: (text) => {
        if (text.includes("/app/keys")) {
          events.push("url");
        }
      },
      readSecret: () => {
        events.push("prompt");
        return Promise.resolve(API_KEY);
      },
    }
  );

  expect(result.exitCode).toBe(0);
  expect(events).toContain("url");
  expect(events).toEqual(["url", "prompt", "network"]);
  expect(result.stdout).not.toContain(API_KEY);
  const identifiers = credentialIdentifiers(apiBaseUrl);
  expect(store.getEntry(identifiers.service, identifiers.account)).toBe(
    JSON.stringify({
      version: 1,
      apiOrigin: identifiers.apiOrigin,
      token: API_KEY,
    })
  );

  events.length = 0;
  const repeated = await runPackedAuth(
    ["--base-url", `${apiBaseUrl}/packed-auth`, "--login"],
    {
      fetch: () => {
        events.push("network");
        return Promise.reject(new Error("repeated login must not fetch"));
      },
      loadCredentialStore: store.loader,
      readSecret: () => {
        events.push("prompt");
        return Promise.resolve(API_KEY);
      },
    }
  );
  expect(repeated).toEqual({
    exitCode: 0,
    stderr: "",
    stdout: `Already logged in to ${identifiers.apiOrigin}.\n`,
  });
  expect(events).toEqual([]);
});

test("packed auth validates status, isolates origins, and logs out locally", async () => {
  const store = createCredentialStoreFixture();
  const baseUrl = "https://packed-auth.example";
  store.seed(
    credentialIdentifiers(baseUrl).service,
    credentialIdentifiers(baseUrl).account,
    JSON.stringify({ version: 1, apiOrigin: baseUrl, token: API_KEY })
  );
  let networkCalls = 0;
  const fetchTenant = () => {
    networkCalls += 1;
    return Promise.resolve(
      Response.json({ name: "Packed Tenant", quota: null })
    );
  };

  const status = await runPackedAuth(["--base-url", baseUrl, "--status"], {
    fetch: fetchTenant,
    loadCredentialStore: store.loader,
  });
  expect(status.exitCode).toBe(0);
  expect(status.stdout).toContain("Credential source: native credential store");
  expect(status.stdout).toContain("Remote validity: valid");
  expect(status.stdout).not.toMatch(SECRET_METADATA_PATTERN);
  expect(networkCalls).toBe(1);

  const isolated = await runPackedAuth(
    ["--base-url", "https://other-packed-auth.example", "--status"],
    {
      fetch: () => Promise.reject(new Error("origin isolation must not fetch")),
      loadCredentialStore: store.loader,
    }
  );
  expect(isolated.exitCode).toBe(1);
  expect(isolated.stdout).toContain("Credential source: none");

  const logout = await runPackedAuth(["--base-url", baseUrl, "--logout"], {
    loadCredentialStore: store.loader,
  });
  expect(logout.exitCode).toBe(0);
  expect(logout.stdout).toContain("Logged out locally");
  expect(logout.stdout).toContain(`${baseUrl}/app/keys`);
  expect(logout.stderr).toContain("remote CLI API key remains active");
  expect(logout.stdout + logout.stderr).not.toContain(API_KEY);
  expect(
    store.getEntry(
      credentialIdentifiers(baseUrl).service,
      credentialIdentifiers(baseUrl).account
    )
  ).toBeNull();
});

test("packed auth reports a dashboard key still active when native storage fails", async () => {
  const store = createCredentialStoreFixture();
  store.failures.set = new Error("native secret detail");
  const result = await runPackedAuth(
    ["--base-url", "https://packed-storage.example", "--login"],
    {
      fetch: () =>
        Promise.resolve(Response.json({ name: "Packed Tenant", quota: null })),
      loadCredentialStore: store.loader,
      readSecret: () => Promise.resolve(STORAGE_FAILURE_KEY),
    }
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(
    "dashboard-created CLI API key remains active"
  );
  expect(result.stderr).toContain("revoke it in the dashboard");
  expect(result.stderr).not.toContain("native secret detail");
  expect(result.stderr).not.toContain(STORAGE_FAILURE_KEY);
  expect(store.entries.size).toBe(0);
});
