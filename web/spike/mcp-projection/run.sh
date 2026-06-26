#!/usr/bin/env bash
# mcp-projection spike (ADR 0001 — eddy = projection compiler): a schema (as claims)
# projects mechanically into an MCP tool catalog + claim-backed handlers. Proves the
# charter for the API/MCP surface. Prereqs: bb; fram built at $FRAM_OUT (default ~/code/fram/out).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
bb -cp "${FRAM_OUT:-$HOME/code/fram/out}" "$here/catalog.clj"
