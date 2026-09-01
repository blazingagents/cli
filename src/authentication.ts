import type { BlazingAgentsOptions } from "@blazingagents/sdk";
import type { ResolvedConfiguration } from "./config.ts";
import {
  type CredentialStore,
  type CredentialStoreError,
  type CredentialStoreLoader,
  credentialIdentifiers,
  readCredentialEntry,
  serializeCredential,
} from "./credentials.ts";

export class AuthenticationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuthenticationError";
  }
}

export function dashboardKeyUrl(baseUrl: string): string {
  const origin = new URL(baseUrl).origin;
  if (origin === "https://api.blazingagents.com") {
    return "https://www.blazingagents.com/app/keys";
  }
  if (origin === "http://localhost:8787") {
    return "http://localhost:5173/app/keys";
  }
  return new URL("/app/keys", origin).toString();
}

async function validateRemoteCredential({
  baseUrl,
  failureMessage,
  fetch,
  token,
}: {
  baseUrl: string;
  failureMessage: string;
  fetch?: BlazingAgentsOptions["fetch"];
  token: string;
}): Promise<boolean> {
  const { BlazingAgents, BlazingAgentsError } = await import(
    "@blazingagents/sdk"
  );
  const client = new BlazingAgents({ apiKey: token, baseUrl, fetch });
  try {
    await client.tenant.get();
    return true;
  } catch (error) {
    if (BlazingAgentsError.isInstance(error) && error.code === "unauthorized") {
      return false;
    }
    throw new AuthenticationError(failureMessage, { cause: error });
  }
}

async function persistCredential({
  account,
  raw,
  service,
  store,
}: {
  account: string;
  raw: string;
  service: string;
  store: CredentialStore;
}): Promise<void> {
  try {
    await store.setPassword(service, account, raw);
    if ((await store.getPassword(service, account)) !== raw) {
      throw new Error("credential read verification failed");
    }
  } catch (cause) {
    try {
      await store.deletePassword(service, account);
    } catch {
      // The dashboard-created key remains active and must be revoked there.
    }
    throw new AuthenticationError(
      "Native credential storage failed. The dashboard-created CLI API key remains active; revoke it in the dashboard before retrying.",
      { cause }
    );
  }
}

function readEntry(
  store: CredentialStore,
  identifiers: ReturnType<typeof credentialIdentifiers>,
  suffix = ""
) {
  return readCredentialEntry(
    store,
    identifiers.service,
    identifiers.account,
    identifiers.apiOrigin
  ).catch((error: unknown) => {
    const credentialError = error as CredentialStoreError;
    throw new AuthenticationError(`${credentialError.message}${suffix}`, {
      cause: error,
    });
  });
}

type CredentialSource =
  | { source: "environment"; token: string }
  | { source: "native credential store"; token: string }
  | { source: "none" };

async function selectCredentialSource({
  environment,
  identifiers,
  loadCredentialStore,
}: {
  environment: NodeJS.ProcessEnv;
  identifiers: ReturnType<typeof credentialIdentifiers>;
  loadCredentialStore: CredentialStoreLoader;
}): Promise<CredentialSource> {
  const environmentToken = environment.BLAZING_AGENTS_API_KEY?.trim();
  if (environmentToken) {
    return { source: "environment", token: environmentToken };
  }
  if (environment.CI) {
    throw new AuthenticationError(
      "Authentication is required in CI. Set BLAZING_AGENTS_API_KEY."
    );
  }

  const store = await loadCredentialStore().catch((cause: unknown) => {
    throw new AuthenticationError(
      "The native credential store is unavailable. Unlock or enable it, or set BLAZING_AGENTS_API_KEY for headless use.",
      { cause }
    );
  });
  const entry = await readEntry(store, identifiers);
  return entry
    ? { source: "native credential store", token: entry.record.token }
    : { source: "none" };
}

export async function resolveAuthentication({
  configuration,
  environment,
  loadCredentialStore,
}: {
  configuration: ResolvedConfiguration;
  environment: NodeJS.ProcessEnv;
  loadCredentialStore: CredentialStoreLoader;
}) {
  const identifiers = credentialIdentifiers(configuration.baseUrl);
  const credential = await selectCredentialSource({
    environment,
    identifiers,
    loadCredentialStore,
  });
  if (credential.source === "none") {
    throw new AuthenticationError(
      `No stored credential exists for ${identifiers.apiOrigin}. Run ba --login.`
    );
  }
  return credential;
}

export async function login({
  configuration,
  fetch,
  hostname,
  loadCredentialStore,
  printDashboardUrl,
  readSecret,
  stdinIsTTY,
}: {
  configuration: ResolvedConfiguration;
  fetch?: BlazingAgentsOptions["fetch"];
  hostname: string;
  loadCredentialStore: CredentialStoreLoader;
  printDashboardUrl: (url: string) => void;
  readSecret: (prompt: string) => Promise<string>;
  stdinIsTTY: boolean;
}) {
  if (!stdinIsTTY) {
    throw new AuthenticationError("Login requires an interactive terminal.");
  }

  const identifiers = credentialIdentifiers(configuration.baseUrl);
  const store = await loadCredentialStore().catch((cause: unknown) => {
    throw new AuthenticationError(
      "The native credential store is unavailable. Unlock or enable it and retry.",
      { cause }
    );
  });
  const previous = await readEntry(store, identifiers);
  if (previous) {
    return {
      stderr: "",
      stdout: `Already logged in to ${identifiers.apiOrigin}.\n`,
    };
  }

  const keyUrl = dashboardKeyUrl(configuration.baseUrl);
  printDashboardUrl(keyUrl);

  let token: string;
  try {
    token = (
      await readSecret(
        `CLI API key (create “Blazing Agents CLI (${hostname})” in the dashboard): `
      )
    ).trim();
  } catch (cause) {
    throw new AuthenticationError("Login was cancelled.", { cause });
  }
  if (!token) {
    throw new AuthenticationError("A CLI API key is required.");
  }

  const valid = await validateRemoteCredential({
    baseUrl: configuration.baseUrl,
    failureMessage:
      "Unable to validate the CLI API key. Check the key and API origin, then retry.",
    fetch,
    token,
  });
  if (!valid) {
    throw new AuthenticationError(
      "The CLI API key could not be validated. Check the key and API origin, then retry."
    );
  }

  const raw = serializeCredential({
    version: 1,
    apiOrigin: identifiers.apiOrigin,
    token,
  });
  await persistCredential({
    account: identifiers.account,
    raw,
    service: identifiers.service,
    store,
  });

  return {
    stderr: "",
    stdout: `Logged in to ${identifiers.apiOrigin}.\nStored CLI API key locally.\n`,
  };
}

export async function logout({
  configuration,
  environment,
  loadCredentialStore,
}: {
  configuration: ResolvedConfiguration;
  environment: NodeJS.ProcessEnv;
  loadCredentialStore: CredentialStoreLoader;
}) {
  const identifiers = credentialIdentifiers(configuration.baseUrl);
  const environmentOverrideWarning = environment.BLAZING_AGENTS_API_KEY?.trim()
    ? "Warning: BLAZING_AGENTS_API_KEY remains active for subsequent commands."
    : "";
  const environmentOverrideSuffix = environmentOverrideWarning
    ? ` ${environmentOverrideWarning}`
    : "";
  const store = await loadCredentialStore().catch((cause: unknown) => {
    throw new AuthenticationError(
      `The native credential store is unavailable. Unlock or enable it and retry logout.${environmentOverrideSuffix}`,
      { cause }
    );
  });
  const entry = await readEntry(store, identifiers, environmentOverrideSuffix);
  if (!entry) {
    throw new AuthenticationError(
      `No stored credential exists for ${identifiers.apiOrigin}.${environmentOverrideSuffix}`
    );
  }

  try {
    await store.deletePassword(identifiers.service, identifiers.account);
  } catch (cause) {
    throw new AuthenticationError(
      `Local credential deletion failed. The remote CLI API key remains active; revoke it at ${dashboardKeyUrl(configuration.baseUrl)}.${environmentOverrideSuffix}`,
      { cause }
    );
  }

  let stderr = "The remote CLI API key remains active.\n";
  if (environmentOverrideWarning) {
    stderr += `${environmentOverrideWarning}\n`;
  }
  return {
    stderr,
    stdout: `Logged out locally from ${identifiers.apiOrigin}. Revoke the remote CLI API key at ${dashboardKeyUrl(configuration.baseUrl)} if needed.\n`,
  };
}

export async function showAuthenticationStatus({
  configuration,
  environment,
  fetch,
  loadCredentialStore,
}: {
  configuration: ResolvedConfiguration;
  environment: NodeJS.ProcessEnv;
  fetch?: BlazingAgentsOptions["fetch"];
  loadCredentialStore: CredentialStoreLoader;
}) {
  const identifiers = credentialIdentifiers(configuration.baseUrl);
  const credential = await selectCredentialSource({
    environment,
    identifiers,
    loadCredentialStore,
  });
  if (credential.source === "none") {
    return {
      exitCode: 1,
      stdout: `API origin: ${identifiers.apiOrigin}
Configuration source: ${configuration.source}
Credential source: none
Remote validity: not checked
`,
    };
  }

  const valid = await validateRemoteCredential({
    baseUrl: configuration.baseUrl,
    failureMessage:
      credential.source === "environment"
        ? "Unable to validate the environment API key. Check the API origin and network, then retry."
        : "Unable to validate the stored API key. Check the API origin and network, then retry.",
    fetch,
    token: credential.token,
  });
  const source =
    credential.source === "environment"
      ? "environment (BLAZING_AGENTS_API_KEY)"
      : credential.source;
  return {
    exitCode: valid ? 0 : 1,
    stdout: `API origin: ${identifiers.apiOrigin}
Configuration source: ${configuration.source}
Credential source: ${source}
Remote validity: ${valid ? "valid" : "invalid"}
`,
  };
}
