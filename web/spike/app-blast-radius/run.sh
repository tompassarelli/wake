#!/usr/bin/env bash
# App-level blast-radius scope-correctness spike (wake x Beagle unified plan, move 1).
# Regenerates the app-claim graph for the fixture and runs the scope-correctness gate.
#
# Proves: wake's app-claim graph yields a SCOPE-CORRECT field-change blast radius —
# includes the genuine dependent (contact.display-name), excludes a same-leaf-named
# decoy on an unrelated entity (note.company) that a bare-name/regex pass drags in.
# The app-level mirror of Beagle's mod_a/mod_b cascade receipt.
#
# Prereqs: bb (babashka); fram built at $FRAM_OUT (default ~/code/fram/out).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
wake_web="$(cd "$here/../.." && pwd)"
claims="${CLAIMS:-/tmp/crm-v2-spike.claims}"
"$wake_web/bin/wake-compile" --claims "$wake_web/demo/crm-v2-spike.wake" "$claims" 1>&2
CLAIMS="$claims" bb -cp "${FRAM_OUT:-$HOME/code/fram/out}" "$here/cascade.clj"
