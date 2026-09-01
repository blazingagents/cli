import { expect, test } from "vitest";
import {
  API_KEY,
  API_ORIGIN,
  captureAuthentication,
  credentialRecord,
  INVALID_API_KEY,
  identifiers,
  SERVICE,
  tenantResponse,
} from "./test/authentication-fixtures.ts";
import { createCredentialStoreFixture } from "./test/credential-store-fixture.ts";

test("status reports environment and native validity without key metadata", async () => {
  const valid = await captureAuthentication(["--status"], {
    environment: { BLAZING_AGENTS_API_KEY: API_KEY },
    fetch: () => Promise.resolve(tenantResponse()),
    loadCredentialStore: () => {
      throw new Error("must not load");
    },
  });
  expect(valid).toEqual({
    exitCode: 0,
    stderr: "",
    stdout: `API origin: ${API_ORIGIN}
Configuration source: default
Credential source: environment (BLAZING_AGENTS_API_KEY)
Remote validity: valid
`,
  });

  const nativeStore = createCredentialStoreFixture();
  nativeStore.seed(
    identifiers.service,
    identifiers.account,
    credentialRecord()
  );
  const native = await captureAuthentication(["--status"], {
    fetch: () => Promise.resolve(tenantResponse()),
    loadCredentialStore: nativeStore.loader,
  });
  expect(native.exitCode).toBe(0);
  expect(native.stdout).toContain("Credential source: native credential store");
  expect(native.stdout).toContain("Remote validity: valid");
  expect(native.stdout).not.toContain("Stored API key");
  expect(native.stdout).not.toContain("fragment");
  expect(native.stdout).not.toContain("expiry");

  const nativeInvalidStore = createCredentialStoreFixture();
  nativeInvalidStore.seed(
    identifiers.service,
    identifiers.account,
    credentialRecord(INVALID_API_KEY)
  );
  const nativeInvalid = await captureAuthentication(["--status"], {
    fetch: () => Promise.resolve(tenantResponse(401)),
    loadCredentialStore: nativeInvalidStore.loader,
  });
  expect(nativeInvalid.exitCode).toBe(1);
  expect(nativeInvalid.stdout).toContain("Remote validity: invalid");

  const invalid = await captureAuthentication(["--status"], {
    environment: { BLAZING_AGENTS_API_KEY: INVALID_API_KEY },
    fetch: () => Promise.resolve(tenantResponse(401)),
    loadCredentialStore: nativeStore.loader,
  });
  expect(invalid.exitCode).toBe(1);
  expect(invalid.stdout).toContain("Remote validity: invalid");
});

test("status handles CI, missing, corrupt, and network failures safely", async () => {
  const ciStore = createCredentialStoreFixture();
  const ci = await captureAuthentication(["--status"], {
    environment: { CI: "true" },
    loadCredentialStore: ciStore.loader,
  });
  expect(ci.stderr).toContain("Authentication is required in CI");
  expect(ciStore.loadCount).toBe(0);

  const missing = await captureAuthentication(["--status"], {
    loadCredentialStore: createCredentialStoreFixture().loader,
  });
  expect(missing.exitCode).toBe(1);
  expect(missing.stdout).toContain("Credential source: none");

  const corruptStore = createCredentialStoreFixture();
  corruptStore.seed(
    identifiers.service,
    identifiers.account,
    '{"token":"SECRET"}'
  );
  const corrupt = await captureAuthentication(["--status"], {
    loadCredentialStore: corruptStore.loader,
  });
  expect(corrupt.stderr).toContain(`${SERVICE} / ${identifiers.account}`);
  expect(corrupt.stderr).not.toContain("SECRET");

  const environmentNetwork = await captureAuthentication(["--status"], {
    environment: { BLAZING_AGENTS_API_KEY: API_KEY },
    fetch: () => Promise.reject(new Error("SECRET environment network")),
    loadCredentialStore: () => {
      throw new Error("must not load");
    },
  });
  expect(environmentNetwork.stderr).toBe(
    "Unable to validate the environment API key. Check the API origin and network, then retry.\n"
  );

  const networkStore = createCredentialStoreFixture();
  networkStore.seed(
    identifiers.service,
    identifiers.account,
    credentialRecord()
  );
  const network = await captureAuthentication(["--status"], {
    fetch: () => Promise.reject(new Error("SECRET network")),
    loadCredentialStore: networkStore.loader,
  });
  expect(network.stderr).toBe(
    "Unable to validate the stored API key. Check the API origin and network, then retry.\n"
  );
  expect(network.stderr).not.toContain("SECRET");

  const unavailable = await captureAuthentication(["--status"], {
    loadCredentialStore: () => Promise.reject(new Error("SECRET load")),
  });
  expect(unavailable.stderr).toContain(
    "native credential store is unavailable"
  );
  expect(unavailable.stderr).not.toContain("SECRET");
});
