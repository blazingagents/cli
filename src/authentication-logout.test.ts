import { expect, test } from "vitest";
import {
  captureAuthentication,
  credentialRecord,
  INVALID_API_KEY,
  identifiers,
  SERVICE,
  tenantResponse,
} from "./test/authentication-fixtures.ts";
import { createCredentialStoreFixture } from "./test/credential-store-fixture.ts";

test("logout deletes only local state and points to dashboard revocation", async () => {
  const store = createCredentialStoreFixture();
  store.seed(identifiers.service, identifiers.account, credentialRecord());
  let networkCalls = 0;
  const result = await captureAuthentication(["--logout"], {
    fetch: () => {
      networkCalls += 1;
      return Promise.resolve(tenantResponse());
    },
    loadCredentialStore: store.loader,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Logged out locally");
  expect(result.stdout).toContain("https://www.blazingagents.com/app/keys");
  expect(result.stderr).toContain("remote CLI API key remains active");
  expect(result.stderr).not.toContain("BLAZING_AGENTS_API_KEY remains active");
  expect(networkCalls).toBe(0);
  expect(store.entries.size).toBe(0);
});

test("logout keeps the environment override warning while removing local state", async () => {
  const store = createCredentialStoreFixture();
  store.seed(identifiers.service, identifiers.account, credentialRecord());
  const result = await captureAuthentication(["--logout"], {
    environment: { BLAZING_AGENTS_API_KEY: INVALID_API_KEY },
    loadCredentialStore: store.loader,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("BLAZING_AGENTS_API_KEY remains active");
});

test("logout preserves local state when deletion fails and reports dashboard cleanup", async () => {
  const store = createCredentialStoreFixture();
  store.seed(identifiers.service, identifiers.account, credentialRecord());
  store.failures.delete = new Error("SECRET delete failure");
  const result = await captureAuthentication(["--logout"], {
    loadCredentialStore: store.loader,
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("remote CLI API key remains active");
  expect(result.stderr).not.toContain("SECRET");
  expect(store.entries.size).toBe(1);
});

test("logout reports missing and corrupt native records safely", async () => {
  const missing = await captureAuthentication(["--logout"], {
    loadCredentialStore: createCredentialStoreFixture().loader,
  });
  expect(missing.stderr).toContain("No stored credential exists");

  const corruptStore = createCredentialStoreFixture();
  corruptStore.seed(
    identifiers.service,
    identifiers.account,
    '{"token":"SECRET"}'
  );
  const corrupt = await captureAuthentication(["--logout"], {
    loadCredentialStore: corruptStore.loader,
  });
  expect(corrupt.stderr).toContain(`${SERVICE} / ${identifiers.account}`);
  expect(corrupt.stderr).not.toContain("SECRET");
});
