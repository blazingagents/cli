import { createHash } from "node:crypto";
import { z } from "zod";
import { apiKeyTokenSchema } from "./contracts.ts";

export const CREDENTIAL_SERVICE = "com.blazing-agents.cli";

export interface CredentialRecord {
  apiOrigin: string;
  token: string;
  version: 1;
}

export interface CredentialStore {
  deletePassword: (service: string, account: string) => Promise<boolean>;
  getPassword: (service: string, account: string) => Promise<string | null>;
  setPassword: (
    service: string,
    account: string,
    password: string
  ) => Promise<void>;
}

export type CredentialStoreLoader = () => Promise<CredentialStore>;

export interface CredentialEntry {
  raw: string;
  record: CredentialRecord;
}

export class CredentialStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CredentialStoreError";
  }
}

function parseCredentialRecord(value: unknown) {
  return z
    .object({
      version: z.literal(1),
      apiOrigin: z.url(),
      token: apiKeyTokenSchema,
    })
    .strict()
    .parse(value);
}

export function credentialIdentifiers(baseUrl: string) {
  const apiOrigin = new URL(baseUrl).origin;
  const digest = createHash("sha256").update(apiOrigin).digest("hex");
  return {
    account: `api:${digest.slice(0, 32)}`,
    apiOrigin,
    service: CREDENTIAL_SERVICE,
  };
}

export async function loadNativeCredentialStore(): Promise<CredentialStore> {
  const { default: store } = await import("@github/keytar");
  return store;
}

export async function readCredentialEntry(
  store: CredentialStore,
  service: string,
  account: string,
  apiOrigin: string
): Promise<CredentialEntry | null> {
  let raw: string | null;
  try {
    raw = await store.getPassword(service, account);
  } catch (cause) {
    throw new CredentialStoreError(
      "The native credential store is unavailable. Unlock or enable it, or set BLAZING_AGENTS_API_KEY for headless use.",
      { cause }
    );
  }
  if (raw === null) {
    return null;
  }
  try {
    const record = await parseCredentialRecord(JSON.parse(raw));
    if (record.apiOrigin !== apiOrigin) {
      throw new Error("credential origin does not match its account");
    }
    return { raw, record };
  } catch (cause) {
    throw new CredentialStoreError(
      `The stored credential is invalid. Remove ${service} / ${account} manually after revoking it in the dashboard.`,
      { cause }
    );
  }
}

export function serializeCredential(record: CredentialRecord) {
  return JSON.stringify(record);
}
