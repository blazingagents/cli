import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  apiBaseUrl,
  cliPack,
  configHome,
  consumerDirectory,
  runBinary,
  runHiddenPromptInPty,
} from "./packed-consumer.fixture.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const MASK_GLYPHS = /[*•▪]/;

test("the tarball contains the compiled application, documents and checked SDK", async () => {
  expect(
    cliPack.files
      .map(({ path }) => path)
      .filter((path) => !path.startsWith("node_modules/"))
  ).toEqual([
    "LICENSE",
    "README.md",
    "dist/agent-resolution.js",
    "dist/assist.js",
    "dist/authentication.js",
    "dist/bin/ba.js",
    "dist/chat-transport.js",
    "dist/chat.js",
    "dist/cli.js",
    "dist/config.js",
    "dist/contracts.js",
    "dist/credentials.js",
    "dist/prompts.js",
    "dist/run-input.js",
    "dist/run-output.js",
    "dist/run.js",
    "dist/tool-approval-decisions.js",
    "dist/tui.js",
    "dist/ui-message-stream.js",
    "package.json",
    "vendor/blazingagents-sdk-0.2.1.tgz",
  ]);
  expect(
    cliPack.files.some(
      ({ path }) => path === "node_modules/@blazingagents/sdk/dist/client.js"
    )
  ).toBe(true);

  const entrypoint = await readFile(
    join(
      consumerDirectory,
      "node_modules",
      "@blazingagents",
      "cli",
      "dist",
      "bin",
      "ba.js"
    ),
    "utf8"
  );
  expect(entrypoint.startsWith("#!/usr/bin/env node\n")).toBe(true);
});

test("the clean consumer has exact lockstep package and runtime versions", async () => {
  const packageDirectory = join(consumerDirectory, "node_modules");
  const manifests = await Promise.all(
    [
      ["cli", "@blazingagents", "cli"],
      ["sdk", "@blazingagents", "cli", "node_modules", "@blazingagents", "sdk"],
      ["tui", "@ai-sdk", "tui"],
      ["keytar", "@github", "keytar"],
      ["ai", "ai"],
      ["commander", "commander"],
      ["yaml", "@blazingagents", "cli", "node_modules", "yaml"],
    ].map(async ([label, ...segments]) => {
      const manifest = JSON.parse(
        await readFile(
          join(packageDirectory, ...segments, "package.json"),
          "utf8"
        )
      ) as { version: string };
      return [label, manifest.version];
    })
  );
  const cliRequire = createRequire(
    join(packageDirectory, "@blazingagents", "cli", "package.json")
  );
  const zodManifest = JSON.parse(
    await readFile(cliRequire.resolve("zod/package.json"), "utf8")
  ) as { version: string };

  expect({
    ...Object.fromEntries(manifests),
    zod: zodManifest.version,
  }).toEqual({
    ai: "7.0.84",
    cli: "0.1.0",
    commander: "15.0.0",
    keytar: "7.10.6",
    sdk: "0.2.1",
    tui: "1.0.85",
    yaml: "2.9.0",
    zod: "4.5.4",
  });

  const cliManifest = JSON.parse(
    await readFile(
      join(packageDirectory, "@blazingagents", "cli", "package.json"),
      "utf8"
    )
  ) as Record<string, unknown>;
  expect(cliManifest).not.toHaveProperty("exports");
  expect(cliManifest).not.toHaveProperty("main");
  expect(cliManifest.engines).toEqual({ node: ">=24" });

  const sdkManifest = JSON.parse(
    await readFile(
      join(
        packageDirectory,
        "@blazingagents",
        "cli",
        "node_modules",
        "@blazingagents",
        "sdk",
        "package.json"
      ),
      "utf8"
    )
  ) as Record<string, unknown>;
  expect(sdkManifest.peerDependencies).toEqual({ ai: "^7.0.84" });
});

test("the installed real binary provides deterministic help, version, and routing", async () => {
  await expect(runBinary([])).resolves.toMatchObject({
    exitCode: 0,
    stderr: "",
    stdout: expect.stringContaining("Usage: ba [options] [command]"),
  });
  await expect(runBinary(["--version"])).resolves.toEqual({
    exitCode: 0,
    stderr: "",
    stdout: "0.1.0\n",
  });
  for (const [args, usage] of [
    [["assist", "--help"], "Usage: ba assist [options]"],
    [["chat", "--help"], "Usage: ba chat [options] <agent>"],
    [["run", "--help"], "Usage: ba run [options] <agent>"],
  ] as const) {
    await expect(runBinary([...args])).resolves.toMatchObject({
      exitCode: 0,
      stderr: "",
      stdout: expect.stringContaining(usage),
    });
  }
  await expect(
    runBinary(
      [
        "--base-url",
        `${apiBaseUrl}/routing`,
        "run",
        "Release Agent",
        "--prompt",
        "hello",
      ],
      { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
    )
  ).resolves.toEqual({
    exitCode: 0,
    stderr: "",
    stdout: "Hello from the Agent",
  });
});

test("snapshotted help matches the packed binary", async () => {
  const sections: string[] = [];
  for (const args of [
    ["--help"],
    ["assist", "--help"],
    ["chat", "--help"],
    ["run", "--help"],
  ]) {
    const result = await runBinary(args);
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    sections.push(`$ ba ${args.join(" ")}\n${result.stdout.trimEnd()}`);
  }
  const snapshot = await readFile(join(repositoryRoot, "help.txt"), "utf8");
  const expected = `${sections.join("\n\n")}\n`;
  const canonicalSnapshot = snapshot.replaceAll("\r\n", "\n");
  expect(canonicalSnapshot).toBe(expected);
});

test.runIf(process.platform !== "win32")(
  "the executable example invokes the packed binary",
  async () => {
    const example = join(repositoryRoot, "examples", "run-json.sh");
    const { stderr, stdout } = await new Promise<{
      stderr: string;
      stdout: string;
    }>((resolve, reject) => {
      const child = spawn(example, ["Release Agent", "hello"], {
        env: {
          ...process.env,
          BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}`,
          BLAZING_AGENTS_BASE_URL: apiBaseUrl,
          HOME: join(consumerDirectory, "home"),
          NO_COLOR: "1",
          PATH: `${join(consumerDirectory, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`,
          XDG_CONFIG_HOME: configHome,
        },
      });
      let capturedStderr = "";
      let capturedStdout = "";
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        capturedStderr += chunk;
      });
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        capturedStdout += chunk;
      });
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Executable example timed out after 20000ms"));
      }, 20_000);
      child.once("error", reject);
      child.once("close", () => {
        clearTimeout(timeout);
        resolve({ stderr: capturedStderr, stdout: capturedStdout });
      });
      child.stdin.end();
    });
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      agent: { name: "Release Agent" },
      output: "Hello from the Agent",
    });
  },
  30_000
);

test("the real binary reports all invocation mistakes with exit 2 and usage", async () => {
  for (const args of [
    ["unknown"],
    ["--unknown"],
    ["assist", "extra"],
    ["chat"],
    ["--login", "--logout"],
    ["--status", "run", "Release Agent"],
  ]) {
    const result = await runBinary(args);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error:");
    expect(result.stderr).toContain("Usage: ba");
  }
});

test("the real binary enforces strict packed configuration", async () => {
  const configDirectory = join(configHome, "blazing-agents");
  await mkdir(configDirectory);
  const configPath = join(configDirectory, "config.yaml");
  await writeFile(configPath, "apiKey: secret-value\n");

  const invalid = await runBinary(["run", "Release Agent"]);
  expect(invalid.exitCode).toBe(2);
  expect(invalid.stderr).toContain("Invalid configuration at");
  expect(invalid.stderr).not.toContain("secret-value");
  await rm(configPath);
});

test("packed login prompt cancels on Ctrl+D and keeps normal secrets hidden", async () => {
  const cancelled = await runHiddenPromptInPty(String.raw`
expect -exact {Key: }
send -- "\004"
expect -exact {Input cancelled.}
`);
  expect(cancelled.exitCode).toBe(0);

  const entered = await runHiddenPromptInPty(String.raw`
expect -exact {Key: }
send -- {ba_secret}
send -- "\r"
expect -exact {Length: 9}
`);
  expect(entered.exitCode).toBe(0);
  expect(entered.output).not.toContain("ba_secret");
  expect(entered.output).not.toMatch(MASK_GLYPHS);
});

test("the packed binary loads native credentials only when required and keeps CI headless", async () => {
  await rename(
    join(consumerDirectory, "node_modules", "@ai-sdk", "tui"),
    join(consumerDirectory, "node_modules", "@ai-sdk", "tui.hidden")
  );
  await rename(
    join(consumerDirectory, "node_modules", "@github", "keytar"),
    join(consumerDirectory, "node_modules", "@github", "keytar.hidden")
  );

  for (const args of [["--help"], ["--version"]]) {
    expect((await runBinary(args)).exitCode).toBe(0);
  }
  expect(
    (
      await runBinary(["assist"], {
        BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}`,
      })
    ).exitCode
  ).toBe(1);
  expect(
    (
      await runBinary(["chat", "Release Agent"], {
        BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}`,
      })
    ).exitCode
  ).toBe(1);

  expect(
    (
      await runBinary(
        [
          "--base-url",
          `${apiBaseUrl}/lazy`,
          "run",
          "Release Agent",
          "--prompt",
          "hello",
        ],
        { BLAZING_AGENTS_API_KEY: `ba_${"e".repeat(40)}` }
      )
    ).exitCode
  ).toBe(0);

  const ci = await runBinary(["run", "Release Agent", "--prompt", "hello"], {
    CI: "true",
  });
  expect(ci).toEqual({
    exitCode: 1,
    stderr: "Authentication is required in CI. Set BLAZING_AGENTS_API_KEY.\n",
    stdout: "",
  });

  const native = await runBinary(["--status"]);
  expect(native.exitCode).toBe(1);
  expect(native.stderr).toContain("native credential store is unavailable");
  expect(native.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
});
