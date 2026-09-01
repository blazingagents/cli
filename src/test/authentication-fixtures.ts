import { type CliRuntime, executeCli } from "../cli.ts";
import { credentialIdentifiers, serializeCredential } from "../credentials.ts";

export const API_ORIGIN = "https://api.blazingagents.com";
export const API_KEY = `ba_${"d".repeat(40)}`;
export const INVALID_API_KEY = `ba_${"i".repeat(40)}`;
export const SERVICE = "com.blazing-agents.cli";
export const identifiers = credentialIdentifiers(API_ORIGIN);

export function credentialRecord(
  token = API_KEY,
  apiOrigin = API_ORIGIN
): string {
  return serializeCredential({ version: 1, apiOrigin, token });
}

export function tenantResponse(status = 200): Response {
  return status === 200
    ? Response.json({ name: "Tenant", quota: null })
    : Response.json(
        { error: { code: "unauthorized", message: "Unauthorized" } },
        { status }
      );
}

export async function captureAuthentication(
  args: string[],
  runtime: Partial<CliRuntime>
) {
  let stdout = "";
  let stderr = "";
  const exitCode = await executeCli(args, {
    environment: {},
    stderr: (text) => {
      stderr += text;
    },
    stdout: (text) => {
      stdout += text;
    },
    version: "0.1.0",
    ...runtime,
  });
  return { exitCode, stderr, stdout };
}
