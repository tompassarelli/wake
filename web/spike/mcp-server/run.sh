#!/usr/bin/env bash
# mcp-server spike (task #41, ADR 0001 — eddy = projection compiler): a runnable MCP
# server host that serves an eddy emit-mcp tool catalog over a Fram CLAIM store.
#
# The host (dispatch core + claim handlers) is authored in BEAGLE (host.bclj) and TYPED
# against the fram API (beagle check --agent host.bclj: 0 errors). This script:
#   1. (re)builds host.bclj -> host.clj with the beagle compiler (the dogfood artifact),
#   2. generates a real emit-mcp catalog from demo/crm-v2.eddy (falls back to a checked-in
#      catalog if eddy-compile is unavailable in this env),
#   3. runs the gate over real fram (bb -cp ~/code/fram/out): tools/list + tools/call for
#      create x2 + a relation edge + list + the *_closure tool, with hard assertions.
#
# Prereqs: bb (babashka); fram built at $FRAM_OUT (default ~/code/fram/out);
#          beagle CLI at $BEAGLE (default ~/code/beagle/bin/beagle).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
eddy_web="$(cd "$here/../.." && pwd)"
FRAM_OUT="${FRAM_OUT:-$HOME/code/fram/out}"
BEAGLE="${BEAGLE:-$HOME/code/beagle/bin/beagle}"

# 1. rebuild the BEAGLE host artifact (host.bclj is the source of truth)
if [[ -x "$BEAGLE" ]]; then
  "$BEAGLE" build "$here/host.bclj" "$here/host.clj" 1>&2
else
  echo "beagle CLI not found ($BEAGLE) — using the committed host.clj build artifact" >&2
fi

# 2. generate the emit-mcp catalog (crm-v2 has a Ref -> a *_closure tool); fall back if needed
cat_json="${CATALOG:-/tmp/cat.json}"
if [[ ! -s "$cat_json" ]]; then
  "$eddy_web/bin/eddy-compile" --mcp "$eddy_web/demo/crm-v2.eddy" > "$cat_json" 2>/dev/null \
    || echo "eddy-compile --mcp unavailable; gate will use its hand-supplied crm-v2 catalog" >&2
fi

# 3. run the gate over real fram
CATALOG="$cat_json" bb -cp "$FRAM_OUT" "$here/gate.clj"
