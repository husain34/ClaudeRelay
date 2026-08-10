#!/usr/bin/env bash
# start-proxy.sh — Start the Anthropic→OpenAI proxy on Linux / macOS
# Usage: ./start-proxy.sh
# Make executable first: chmod +x start-proxy.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

exec node "proxy.js"
