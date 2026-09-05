<div align="center">
  <a href="https://docs.blazingagents.com">
    <img src="https://raw.githubusercontent.com/blazingagents/docs/main/public/brand/icon.svg" alt="Blazing Agents logo" width="96">
  </a>
  <h1>Blazing Agents CLI</h1>
  <p>Chat with, run, and manage Blazing Agents from your terminal.</p>
  <p>
    <a href="https://docs.blazingagents.com/cli">Documentation</a> ·
    <a href="https://www.npmjs.com/package/@blazingagents/cli">npm</a>
  </p>
</div>

The open-source command-line interface requires Node.js 24 or newer. Linux
systems also need the `libsecret-1-0` runtime package.

## Features

- Chat with an Agent in an interactive terminal interface.
- Run one-off prompts from a shell script or CI job.
- Use Agent-assisted workflows from the command line.
- Store sign-in credentials securely in the operating system keychain.
- Target another Blazing Agents deployment with a flag or configuration file.

## Install

```sh
npm install --global @blazingagents/cli
ba --help
```

Run without installing globally:

```sh
npx @blazingagents/cli --help
```

## Commands

```sh
ba --login
ba assist
ba chat 'Release Agent'
ba run 'Release Agent' --prompt 'Summarize the latest release'
```

Use `ba --help` or a command-specific `--help` for every option.

For CI and other headless environments, provide an API key through the process
environment:

```sh
export BLAZING_AGENTS_API_KEY='ba_...'
ba run 'Release Agent' --prompt 'Give the status' --json
```

The default API is `https://api.blazingagents.com`. Override it with
`--base-url`, `BLAZING_AGENTS_BASE_URL`, or a `baseUrl` entry in
`${XDG_CONFIG_HOME:-~/.config}/blazing-agents/config.yaml`.

## Documentation

See the [CLI documentation](https://docs.blazingagents.com/cli) for setup,
authentication, command guides, and CI usage.

### Thinking level

In `ba assist`, ask to create an Agent with a Thinking level, read its current
level, set it to a value such as `high`, or clear it to Provider default.
The hosted Agent Tool accepts `thinkingLevel` and preserves update approval.
Known capabilities constrain choices; unknown capabilities accept custom
strings that may still be rejected during execution. `ba chat` and `ba run`
use the resolved Agent Version's selection without a per-Turn override.
Configure the Admin Agent's own Thinking level in the dashboard or SDK.
