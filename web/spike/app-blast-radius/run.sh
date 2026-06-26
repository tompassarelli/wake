#!/usr/bin/env bash
# App-level blast-radius scope-correctness spike (eddy x Beagle unified plan, move 1).
# Regenerates the app-claim graph for the fixture and runs the scope-correctness gate.
#
# Proves: eddy's app-claim graph yields a SCOPE-CORRECT field-change blast radius —
# includes the genuine dependent (contact.display-name), excludes a same-leaf-named
# decoy on an unrelated entity (note.company) that a bare-name/regex pass drags in.
# The app-level mirror of Beagle's mod_a/mod_b cascade receipt.
#
# Prereqs: bb (babashka); fram built at $FRAM_OUT (default ~/code/fram/out).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
eddy_web="$(cd "$here/../.." && pwd)"
claims="${CLAIMS:-/tmp/crm-v2-spike.claims}"
"$eddy_web/bin/eddy-compile" --claims "$eddy_web/demo/crm-v2-spike.eddy" "$claims" 1>&2
CLAIMS="$claims" bb -cp "${FRAM_OUT:-$HOME/code/fram/out}" "$here/cascade.clj"
