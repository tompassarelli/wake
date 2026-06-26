#!/usr/bin/env bash
# eddy-on-claims spike (ADR 0001, the apps pillar): an eddy app's DATA backed by a
# Fram CLAIM store instead of SQL. Runs the gen-store CRUD seam as claim operations
# and gates the greenfield thesis: history + scope-correct relational reasoning fall
# out for free, where emit-sql/emit-server destroy history (UPDATE) and need recursive
# CTEs for transitive queries.
#
# Prereqs: bb (babashka); fram built at $FRAM_OUT (default ~/code/fram/out).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
bb -cp "${FRAM_OUT:-$HOME/code/fram/out}" "$here/store.clj"
