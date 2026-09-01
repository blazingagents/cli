import { expect, test } from "vitest";
import { credentialIdentifiers } from "./credentials.ts";
import {
  API_KEY,
  API_ORIGIN,
  captureAuthentication,
  credentialRecord,
  identifiers,
  SERVICE,
} from "./test/authentication-fixtures.ts";
import { createCredentialStoreFixture } from "./test/credential-store-fixture.ts";

test("origin-mismatched native records are rejected without use", async () => {
  const store = createCredentialStoreFixture();
  store.seed(
    identifiers.service,
    identifiers.account,
    credentialRecord(API_KEY, "https://other.example.com")
  );
  const result = await captureAuthentication(["--status"], {
    loadCredentialStore: store.loader,
  });
  expect(result.stderr).toContain(`${SERVICE} / ${identifiers.account}`);
});

test("old-origin and legacy metadata records are not migrated", async () => {
  const oldOriginStore = createCredentialStoreFixture();
  const oldIdentifiers = credentialIdentifiers(
    "https://api.blazing-agents.dev"
  );
  oldOriginStore.seed(
    oldIdentifiers.service,
    oldIdentifiers.account,
    credentialRecord(API_KEY, oldIdentifiers.apiOrigin)
  );
  const isolated = await captureAuthentication(["--status"], {
    loadCredentialStore: oldOriginStore.loader,
  });
  expect(isolated.exitCode).toBe(1);
  expect(isolated.stdout).toContain("Credential source: none");

  const legacyStore = createCredentialStoreFixture();
  legacyStore.seed(
    identifiers.service,
    identifiers.account,
    JSON.stringify({
      apiKeyId: "ak_AAAAAAAAAAAAAAAA",
      apiOrigin: API_ORIGIN,
      expiresAt: null,
      token: API_KEY,
      version: 1,
    })
  );
  let prompted = 0;
  const legacy = await captureAuthentication(["--login"], {
    loadCredentialStore: legacyStore.loader,
    readSecret: () => {
      prompted += 1;
      return Promise.resolve(API_KEY);
    },
    stdinIsTTY: true,
  });
  expect(legacy.stderr).toContain("stored credential is invalid");
  expect({
    prompted,
    raw: legacyStore.getEntry(identifiers.service, identifiers.account),
  }).toEqual({
    prompted: 0,
    raw: JSON.stringify({
      apiKeyId: "ak_AAAAAAAAAAAAAAAA",
      apiOrigin: API_ORIGIN,
      expiresAt: null,
      token: API_KEY,
      version: 1,
    }),
  });
  expect(legacy.stderr).not.toContain(API_KEY);
});
