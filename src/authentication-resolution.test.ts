import { expect, test, vi } from "vitest";
import { resolveAuthentication } from "./authentication.ts";
import {
  API_KEY,
  API_ORIGIN,
  captureAuthentication,
  credentialRecord,
  identifiers,
} from "./test/authentication-fixtures.ts";
import { createCredentialStoreFixture } from "./test/credential-store-fixture.ts";

test("product commands continue using the stored credential", async () => {
  const assistStore = createCredentialStoreFixture();
  assistStore.seed(
    identifiers.service,
    identifiers.account,
    credentialRecord()
  );
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async () => Response.json({ agents: [] }));
  const assist = await captureAuthentication(["assist"], {
    loadCredentialStore: assistStore.loader,
    loadTui: () => Promise.resolve({ runAgentTUI: async () => undefined }),
    stdinIsTTY: true,
    stdoutIsTTY: true,
  });
  vi.stubGlobal("fetch", originalFetch);
  expect(assist.exitCode).toBe(1);

  const runStore = createCredentialStoreFixture();
  runStore.seed(identifiers.service, identifiers.account, credentialRecord());
  const run = await captureAuthentication(
    ["run", "missing", "--prompt", "hello"],
    {
      fetch: (input) =>
        Promise.resolve(
          input.toString().endsWith("/v1/agents")
            ? Response.json({ agents: [] })
            : new Response("generated")
        ),
      loadCredentialStore: runStore.loader,
      stdinIsTTY: true,
    }
  );
  expect(run.exitCode).toBe(1);
});

test("resolveAuthentication preserves environment precedence and native origin isolation", async () => {
  const configuration = { baseUrl: API_ORIGIN, source: "default" as const };
  await expect(
    resolveAuthentication({
      configuration,
      environment: { BLAZING_AGENTS_API_KEY: API_KEY },
      loadCredentialStore: () => {
        throw new Error("must not load");
      },
    })
  ).resolves.toEqual({ source: "environment", token: API_KEY });

  await expect(
    resolveAuthentication({
      configuration,
      environment: { CI: "true" },
      loadCredentialStore: () => {
        throw new Error("must not load");
      },
    })
  ).rejects.toThrow("Authentication is required in CI");

  const store = createCredentialStoreFixture();
  store.seed(identifiers.service, identifiers.account, credentialRecord());
  await expect(
    resolveAuthentication({
      configuration,
      environment: {},
      loadCredentialStore: store.loader,
    })
  ).resolves.toEqual({ source: "native credential store", token: API_KEY });

  await expect(
    resolveAuthentication({
      configuration,
      environment: {},
      loadCredentialStore: createCredentialStoreFixture().loader,
    })
  ).rejects.toThrow("Run ba --login");
});
