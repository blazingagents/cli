# `@blazingagents/cli`

The open-source command-line interface for Blazing Agents. It requires Node.js
24 or newer.

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

See the [CLI documentation](https://docs.blazingagents.com/cli) for the full
guide.
