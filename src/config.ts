import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const baseUrlSchema = z.url({ protocol: /^https?$/ });
const configSchema = z.object({ baseUrl: baseUrlSchema.optional() }).strict();

export class ConfigurationError extends Error {
  override name = "ConfigurationError";
}

export function parseBaseUrl(value: string, source: string) {
  const result = baseUrlSchema.safeParse(value);
  if (!result.success) {
    return {
      error: `Invalid base URL from ${source}; expected an HTTP(S) URL.`,
      success: false,
    } as const;
  }
  return { success: true, value: result.data } as const;
}

export interface ResolveConfigurationOptions {
  baseUrl?: string;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
}

export interface ResolvedConfiguration {
  baseUrl: string;
  source: "default" | "environment" | "flag" | "yaml";
}

export async function resolveConfiguration({
  baseUrl,
  environment = process.env,
  homeDirectory = homedir(),
  platform = process.platform,
}: ResolveConfigurationOptions = {}): Promise<ResolvedConfiguration> {
  let configuredOverride:
    | { label: string; source: "environment" | "flag"; value: string }
    | undefined;
  if (environment.BLAZING_AGENTS_BASE_URL !== undefined) {
    configuredOverride = {
      label: "BLAZING_AGENTS_BASE_URL",
      source: "environment",
      value: environment.BLAZING_AGENTS_BASE_URL,
    };
  }
  if (baseUrl !== undefined) {
    configuredOverride = {
      label: "--base-url",
      source: "flag",
      value: baseUrl,
    };
  }
  if (configuredOverride) {
    const result = parseBaseUrl(
      configuredOverride.value,
      configuredOverride.label
    );
    if (!result.success) {
      throw new ConfigurationError(result.error);
    }
    return {
      baseUrl: result.value,
      source: configuredOverride.source,
    };
  }

  const configHome =
    platform === "win32"
      ? environment.APPDATA || join(homeDirectory, "AppData", "Roaming")
      : environment.XDG_CONFIG_HOME || join(homeDirectory, ".config");
  const configPath = join(configHome, "blazing-agents", "config.yaml");

  let contents: string;
  try {
    contents = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        baseUrl: "https://api.blazingagents.com",
        source: "default",
      };
    }
    throw new ConfigurationError(
      `Unable to read configuration at ${configPath}.`,
      { cause: error }
    );
  }

  try {
    const config = configSchema.parse(
      contents.trim() === "" ? {} : parse(contents)
    );
    if (config.baseUrl) {
      return { baseUrl: config.baseUrl, source: "yaml" };
    }
  } catch (error) {
    throw new ConfigurationError(
      `Invalid configuration at ${configPath}; expected YAML with only an optional HTTP(S) baseUrl.`,
      { cause: error }
    );
  }

  return {
    baseUrl: "https://api.blazingagents.com",
    source: "default",
  };
}
