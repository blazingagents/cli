import { expect, test, vi } from "vitest";
import {
  API_KEY,
  API_ORIGIN,
  captureAuthentication,
  credentialRecord,
  INVALID_API_KEY,
  identifiers,
  tenantResponse,
} from "./test/authentication-fixtures.ts";
import { createCredentialStoreFixture } from "./test/credential-store-fixture.ts";

test("login is a no-op when an origin-scoped credential already exists", async () => {
  const store = createCredentialStoreFixture();
  store.seed(identifiers.service, identifiers.account, credentialRecord());
  const persistedCredential = store.getEntry(
    identifiers.service,
    identifiers.account
  );
  const fetch = vi.fn(() => Promise.resolve(tenantResponse()));
  const setPassword = vi.spyOn(store.store, "setPassword");
  const deletePassword = vi.spyOn(store.store, "deletePassword");
  let printed = 0;
  let prompted = 0;

  const result = await captureAuthentication(["--login"], {
    fetch,
    hostname: "build-mac",
    loadCredentialStore: store.loader,
    readSecret: () => {
      prompted += 1;
      return Promise.resolve(API_KEY);
    },
    stderr: (text) => {
      if (text) {
        printed += 1;
      }
    },
    stdinIsTTY: true,
  });

  expect(result).toEqual({
    exitCode: 0,
    stderr: "",
    stdout: `Already logged in to ${API_ORIGIN}.\n`,
  });
  expect({ printed, prompted }).toEqual({ printed: 0, prompted: 0 });
  expect(fetch).not.toHaveBeenCalled();
  expect(setPassword).not.toHaveBeenCalled();
  expect(deletePassword).not.toHaveBeenCalled();
  expect(store.getEntry(identifiers.service, identifiers.account)).toBe(
    persistedCredential
  );
});

test("first login prints the dashboard URL before the hidden import and stores only origin and token", async () => {
  const store = createCredentialStoreFixture();
  const prompts: string[] = [];
  const requests: Array<{ method: string; url: string }> = [];
  const events: string[] = [];

  const result = await captureAuthentication(["--login"], {
    fetch: (input, init) => {
      events.push("network");
      requests.push({ method: init?.method ?? "GET", url: input.toString() });
      return Promise.resolve(tenantResponse());
    },
    hostname: "build-mac",
    loadCredentialStore: store.loader,
    readSecret: (prompt) => {
      events.push("prompt");
      prompts.push(prompt);
      return Promise.resolve(API_KEY);
    },
    stderr: (text) => {
      if (text) {
        events.push(`url:${text.trim()}`);
      }
    },
    stdinIsTTY: true,
  });

  expect(result).toEqual({
    exitCode: 0,
    stderr: "",
    stdout: `Logged in to ${API_ORIGIN}.\nStored CLI API key locally.\n`,
  });
  expect(events).toEqual([
    "url:https://www.blazingagents.com/app/keys",
    "prompt",
    "network",
  ]);
  expect(prompts).toEqual([
    "CLI API key (create “Blazing Agents CLI (build-mac)” in the dashboard): ",
  ]);
  expect(requests).toEqual([{ method: "GET", url: `${API_ORIGIN}/v1/tenant` }]);
  expect(store.getEntry(identifiers.service, identifiers.account)).toBe(
    credentialRecord()
  );
  expect(JSON.stringify(result)).not.toContain(API_KEY);
});

test("login prints the local dashboard URL before a canceled hidden import", async () => {
  const store = createCredentialStoreFixture();
  const events: string[] = [];
  const result = await captureAuthentication(
    ["--base-url", "http://localhost:8787", "--login"],
    {
      loadCredentialStore: store.loader,
      readSecret: () => {
        events.push("prompt");
        return Promise.reject(new Error("cancel"));
      },
      stderr: (text) => {
        events.push(text.includes("/app/keys") ? "url" : "error");
      },
      stdinIsTTY: true,
    }
  );

  expect(result.exitCode).toBe(1);
  expect(events).toEqual(["url", "prompt", "error"]);
  expect(store.entries.size).toBe(0);
});

test("login rejects noninteractive, empty, invalid, and operational failures without storing", async () => {
  const nonInteractive = await captureAuthentication(["--login"], {
    loadCredentialStore: () => {
      throw new Error("store must not load");
    },
    readSecret: async () => API_KEY,
    stdinIsTTY: false,
  });
  expect(nonInteractive).toEqual({
    exitCode: 1,
    stderr: "Login requires an interactive terminal.\n",
    stdout: "",
  });

  const emptyStore = createCredentialStoreFixture();
  const empty = await captureAuthentication(["--login"], {
    loadCredentialStore: emptyStore.loader,
    readSecret: async () => "  ",
    stdinIsTTY: true,
  });
  expect(empty.stderr).toContain("https://www.blazingagents.com/app/keys\n");
  expect(empty.stderr).toContain("A CLI API key is required.\n");
  expect(emptyStore.entries.size).toBe(0);

  const invalidStore = createCredentialStoreFixture();
  const invalid = await captureAuthentication(["--login"], {
    fetch: () => Promise.resolve(tenantResponse(401)),
    loadCredentialStore: invalidStore.loader,
    readSecret: async () => INVALID_API_KEY,
    stdinIsTTY: true,
  });
  expect(invalid.stderr).toContain("could not be validated");
  expect(invalidStore.entries.size).toBe(0);

  const failed = await captureAuthentication(["--login"], {
    fetch: () => Promise.reject(new Error("SECRET network")),
    loadCredentialStore: createCredentialStoreFixture().loader,
    readSecret: async () => API_KEY,
    stdinIsTTY: true,
  });
  expect(failed.stderr).toContain("Unable to validate");
  expect(failed.stderr).not.toContain("SECRET");
});

test("login storage failure leaves the dashboard-created key active and no local entry", async () => {
  const store = createCredentialStoreFixture();
  store.failures.set = new Error("SECRET native failure");
  const result = await captureAuthentication(["--login"], {
    fetch: () => Promise.resolve(tenantResponse()),
    loadCredentialStore: store.loader,
    readSecret: async () => API_KEY,
    stdinIsTTY: true,
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(
    "dashboard-created CLI API key remains active"
  );
  expect(result.stderr).not.toContain("SECRET");
  expect(store.entries.size).toBe(0);
});

test("storage verification and cleanup failures remain safe", async () => {
  const verification = createCredentialStoreFixture();
  verification.controls.verification = { value: "wrong" };
  const verificationResult = await captureAuthentication(["--login"], {
    fetch: () => Promise.resolve(tenantResponse()),
    loadCredentialStore: verification.loader,
    readSecret: async () => API_KEY,
    stdinIsTTY: true,
  });
  expect(verificationResult.stderr).toContain(
    "dashboard-created CLI API key remains active"
  );

  const cleanup = createCredentialStoreFixture();
  cleanup.failures.set = new Error("write failed");
  cleanup.failures.delete = new Error("delete failed");
  const cleanupResult = await captureAuthentication(["--login"], {
    fetch: () => Promise.resolve(tenantResponse()),
    loadCredentialStore: cleanup.loader,
    readSecret: async () => API_KEY,
    stdinIsTTY: true,
  });
  expect(cleanupResult.stderr).toContain("revoke it in the dashboard");
});
