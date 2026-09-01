import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { resolveConfiguration } from "./config.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

test("the global flag takes precedence over environment and YAML base URLs", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "ba-config-"));
  temporaryDirectories.push(configHome);
  const configDirectory = join(configHome, "blazing-agents");
  await mkdir(configDirectory);
  await writeFile(
    join(configDirectory, "config.yaml"),
    "baseUrl: https://yaml.example.com\n"
  );

  await expect(
    resolveConfiguration({
      baseUrl: "https://flag.example.com",
      environment: {
        BLAZING_AGENTS_BASE_URL: "https://environment.example.com",
        XDG_CONFIG_HOME: configHome,
      },
      platform: "linux",
    })
  ).resolves.toEqual({
    baseUrl: "https://flag.example.com",
    source: "flag",
  });
});

test("the environment base URL takes precedence over YAML", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "ba-config-"));
  temporaryDirectories.push(configHome);
  const configDirectory = join(configHome, "blazing-agents");
  await mkdir(configDirectory);
  await writeFile(
    join(configDirectory, "config.yaml"),
    "baseUrl: https://yaml.example.com\n"
  );

  await expect(
    resolveConfiguration({
      environment: {
        BLAZING_AGENTS_BASE_URL: "https://environment.example.com",
        XDG_CONFIG_HOME: configHome,
      },
      platform: "linux",
    })
  ).resolves.toEqual({
    baseUrl: "https://environment.example.com",
    source: "environment",
  });
});

test("a YAML base URL is used when no process override exists", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "ba-config-"));
  temporaryDirectories.push(configHome);
  const configDirectory = join(configHome, "blazing-agents");
  await mkdir(configDirectory);
  await writeFile(
    join(configDirectory, "config.yaml"),
    "baseUrl: https://yaml.example.com\n"
  );

  await expect(
    resolveConfiguration({
      environment: { XDG_CONFIG_HOME: configHome },
      platform: "linux",
    })
  ).resolves.toEqual({
    baseUrl: "https://yaml.example.com",
    source: "yaml",
  });
});

test("a malformed flag base URL is rejected", async () => {
  await expect(resolveConfiguration({ baseUrl: "not-a-url" })).rejects.toThrow(
    "Invalid base URL from --base-url; expected an HTTP(S) URL."
  );
});

test.each([
  ["malformed YAML", "baseUrl: [\n"],
  ["unknown keys", "apiKey: secret\n"],
  ["invalid values", "baseUrl: ftp://example.com\n"],
  ["null documents", "null\n"],
  ["null shorthand documents", "~\n"],
])("configuration rejects %s", async (_scenario, contents) => {
  const configHome = await mkdtemp(join(tmpdir(), "ba-config-"));
  temporaryDirectories.push(configHome);
  const configDirectory = join(configHome, "blazing-agents");
  await mkdir(configDirectory);
  const configPath = join(configDirectory, "config.yaml");
  await writeFile(configPath, contents);

  await expect(
    resolveConfiguration({
      environment: { XDG_CONFIG_HOME: configHome },
      platform: "linux",
    })
  ).rejects.toThrow(
    `Invalid configuration at ${configPath}; expected YAML with only an optional HTTP(S) baseUrl.`
  );
});

test("a missing configuration file uses the hosted default", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "ba-config-"));
  temporaryDirectories.push(configHome);

  await expect(
    resolveConfiguration({
      environment: { XDG_CONFIG_HOME: configHome },
      platform: "linux",
    })
  ).resolves.toEqual({
    baseUrl: "https://api.blazingagents.com",
    source: "default",
  });
});

test("an empty configuration file uses the hosted default", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "ba-config-"));
  temporaryDirectories.push(configHome);
  const configDirectory = join(configHome, "blazing-agents");
  await mkdir(configDirectory);
  await writeFile(join(configDirectory, "config.yaml"), "");

  await expect(
    resolveConfiguration({
      environment: { XDG_CONFIG_HOME: configHome },
      platform: "linux",
    })
  ).resolves.toEqual({
    baseUrl: "https://api.blazingagents.com",
    source: "default",
  });
});

test.each([
  ["Linux home", "linux", {}, [".config"]],
  ["Windows AppData", "win32", { APPDATA: "APPDATA" }, ["APPDATA"]],
  ["Windows home", "win32", {}, ["AppData", "Roaming"]],
] as const)(
  "configuration uses the standard %s location",
  async (_scenario, platform, environment, pathSegments) => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "ba-config-"));
    temporaryDirectories.push(homeDirectory);
    const configHome =
      "APPDATA" in environment
        ? join(homeDirectory, environment.APPDATA)
        : join(homeDirectory, ...pathSegments);
    const configDirectory = join(configHome, "blazing-agents");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      join(configDirectory, "config.yaml"),
      "baseUrl: http://localhost:8787\n"
    );

    await expect(
      resolveConfiguration({
        environment:
          "APPDATA" in environment
            ? { APPDATA: configHome }
            : { ...environment },
        homeDirectory,
        platform,
      })
    ).resolves.toEqual({
      baseUrl: "http://localhost:8787",
      source: "yaml",
    });
  }
);

test.each([
  ["XDG_CONFIG_HOME", "linux", { XDG_CONFIG_HOME: "" }, [".config"]],
  ["APPDATA", "win32", { APPDATA: "" }, ["AppData", "Roaming"]],
] as const)(
  "an empty %s is treated as unset",
  async (_name, platform, environment, pathSegments) => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "ba-config-"));
    temporaryDirectories.push(homeDirectory);
    const configDirectory = join(
      homeDirectory,
      ...pathSegments,
      "blazing-agents"
    );
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      join(configDirectory, "config.yaml"),
      "baseUrl: http://localhost:8787\n"
    );

    await expect(
      resolveConfiguration({
        environment,
        homeDirectory,
        platform,
      })
    ).resolves.toEqual({
      baseUrl: "http://localhost:8787",
      source: "yaml",
    });
  }
);

test("an invalid environment base URL is rejected", async () => {
  await expect(
    resolveConfiguration({
      environment: { BLAZING_AGENTS_BASE_URL: "ftp://example.com" },
    })
  ).rejects.toThrow(
    "Invalid base URL from BLAZING_AGENTS_BASE_URL; expected an HTTP(S) URL."
  );
});

test("an unreadable configuration path reports a direct error", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "ba-config-"));
  temporaryDirectories.push(configHome);
  const configPath = join(configHome, "blazing-agents", "config.yaml");
  await mkdir(configPath, { recursive: true });

  await expect(
    resolveConfiguration({
      environment: { XDG_CONFIG_HOME: configHome },
      platform: "linux",
    })
  ).rejects.toThrow(`Unable to read configuration at ${configPath}.`);
});
