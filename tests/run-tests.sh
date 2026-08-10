#!/usr/bin/env bash
# tests/run-tests.sh — Run the full test suite on Linux / macOS
#
# What it does:
#   1. Starts proxy.js in the background
#   2. Waits until it's accepting connections
#   3. Runs test-proxy.js  (core suite, 31 assertions)
#   4. Runs limits-test.js (boundary suite, 40 assertions)
#   5. Kills the proxy
#   6. Exits with code 0 (all passed) or 1 (any failure)
#
# Usage:
#   chmod +x tests/run-tests.sh
#   ./tests/run-tests.sh
#
# Or via npm:
#   npm test

set -euo pipefail

# ── Paths ──────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROXY_JS="$ROOT_DIR/proxy.js"
ENV_FILE="$ROOT_DIR/.env"

# Read port from .env, fall back to default
PORT=20128
if [[ -f "$ENV_FILE" ]]; then
    _p="$(grep -oP '(?<=^PROXY_PORT=)\d+' "$ENV_FILE" 2>/dev/null || true)"
    [[ -n "$_p" ]] && PORT="$_p"
fi

HEALTH_URL="http://127.0.0.1:$PORT/health"
PROXY_PID=""

# ── Cleanup on exit ────────────────────────────────────────────────────────────
cleanup() {
    if [[ -n "$PROXY_PID" ]] && kill -0 "$PROXY_PID" 2>/dev/null; then
        echo ""
        echo "  Stopping proxy (PID $PROXY_PID)..."
        kill "$PROXY_PID" 2>/dev/null || true
        wait "$PROXY_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

# ── Start proxy ────────────────────────────────────────────────────────────────
echo ""
echo "  Starting proxy.js..."
cd "$ROOT_DIR"
node "$PROXY_JS" &
PROXY_PID=$!

# ── Wait for proxy to accept connections (up to 15s) ──────────────────────────
echo -n "  Waiting for proxy on port $PORT "
READY=false
for i in $(seq 1 15); do
    if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
        READY=true
        echo " ready!"
        break
    fi
    echo -n "."
    sleep 1
done

if ! $READY; then
    echo ""
    echo "ERROR: Proxy did not start within 15 seconds." >&2
    exit 1
fi

# ── Run test suites ────────────────────────────────────────────────────────────
SUITE1_EXIT=0
SUITE2_EXIT=0

node "$SCRIPT_DIR/test-proxy.js"   || SUITE1_EXIT=$?
echo ""
node "$SCRIPT_DIR/limits-test.js"  || SUITE2_EXIT=$?

# ── Final result ───────────────────────────────────────────────────────────────
echo ""
if [[ $SUITE1_EXIT -eq 0 && $SUITE2_EXIT -eq 0 ]]; then
    echo "  ✓ All test suites passed."
    exit 0
else
    echo "  ✗ One or more test suites failed (suite1=$SUITE1_EXIT suite2=$SUITE2_EXIT)." >&2
    exit 1
fi
