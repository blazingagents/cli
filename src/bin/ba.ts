#!/usr/bin/env node
import { hostname } from "node:os";
import packageMetadata from "../../package.json" with { type: "json" };
import { executeCli } from "../cli.ts";
import { readHiddenInput } from "../prompts.ts";

process.exitCode = await executeCli(process.argv.slice(2), {
  environment: process.env,
  hostname: hostname(),
  platform: process.platform,
  onSignal: (signal, listener) => {
    process.once(signal, listener);
    return () => process.removeListener(signal, listener);
  },
  readSecret: readHiddenInput,
  readStdin: async () => {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
    }
    return input;
  },
  stdinIsTTY: process.stdin.isTTY,
  stderr: (text) => process.stderr.write(text),
  stderrIsTTY: process.stderr.isTTY,
  stdout: (text) => process.stdout.write(text),
  stdoutIsTTY: process.stdout.isTTY,
  version: packageMetadata.version,
});
