#!/bin/sh
set -eu

: "${BLAZING_AGENTS_API_KEY:?Set BLAZING_AGENTS_API_KEY for headless use}"

agent=${1:?Usage: run-json.sh AGENT PROMPT}
prompt=${2:?Usage: run-json.sh AGENT PROMPT}

exec ba run "$agent" --prompt "$prompt" --json
