import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

async function readJson(url: URL) {
  return JSON.parse(await readFile(url, "utf8")) as Record<string, unknown>;
}

test("the CLI bundles the checked SDK with exact runtime pins", async () => {
  const manifest = await readJson(new URL("../package.json", import.meta.url));

  expect(manifest).toMatchObject({
    bin: { ba: "dist/bin/ba.js" },
    dependencies: {
      "@ai-sdk/tui": "1.0.85",
      "@blazingagents/sdk": "file:vendor/blazingagents-sdk-0.2.1.tgz",
      "@clack/prompts": "1.7.0",
      "@github/keytar": "7.10.6",
      ai: "7.0.84",
      commander: "15.0.0",
      yaml: "2.9.0",
      zod: "4.5.4",
    },
    engines: { node: ">=24" },
    files: ["dist", "README.md", "LICENSE", "vendor"],
    license: "MIT",
    name: "@blazingagents/cli",
    type: "module",
    version: "0.1.0",
  });
  expect(manifest).not.toHaveProperty("exports");
  expect(manifest).not.toHaveProperty("main");
});

test("the CLI depends only on public runtime packages", async () => {
  const cli = await readJson(new URL("../package.json", import.meta.url));
  expect(cli.dependencies).not.toHaveProperty("@blazing-agents/core");
  expect(
    (cli.dependencies as Record<string, unknown>)["@blazingagents/sdk"]
  ).toBe("file:vendor/blazingagents-sdk-0.2.1.tgz");
});
