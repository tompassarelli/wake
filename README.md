# Eddy

Eddy is an application compiler: `.eddy` declarations in, plain JavaScript out.

Declare the shape of your app — entities, views, forms, routes, derived fields — and Eddy
emits the direct-DOM code you would otherwise write by hand. No framework runtime, no virtual
DOM, no signal graph. The output is ordinary JavaScript you can read, debug, or keep after
walking away from Eddy.

The thesis — Eddy is a *projection compiler*, the same checked entity graph projected onto
many targets — is `docs/adr/0001-eddy-is-a-projection-compiler.md`. The build log in
`docs/devlog/` is the chronological "why it's shaped this way."

## What it does

From one declaration, Eddy generates a direct-DOM frontend with: per-attribute compiled DOM
mutation (no diffing), a component system with conditional rendering (`when`), click-to-select
split-pane detail, hash routing with shared stores, compile-time-traced derived fields and
cross-entity FK propagation, undo/redo over an event log, and persistence. Apps are themeable
via `(theme :colors ...)`.

The *same* graph also projects onto SQL DDL, a REST server, a test suite, and more — so the
targets can't drift from each other. Add `:unique` to a field once and the schema, the server
validation, and the tests all follow.

## Example

A small, illustrative source. The runnable demos live in `web/demo/*.eddy` — read those for
current, compiler-verified syntax (this snippet is prose and can lag; the demo files can't).

```scheme
(ns eddy.tracker)
(persist :localStorage "eddy-tracker")

(entity task
  (title : String)
  (done : String))

(component task-row
  :props [title done]
  (div :class "flex items-center gap-4 px-4 py-2.5"
    (span :class "flex-1 text-sm" :text title)
    (when done
      (span :class "text-green-600 text-xs" :text "Done"))))

(view tasks
  :entity task :each task-row
  :add-form [title done] :title "Tasks"
  :select task-row)

(routes :default tasks [tasks tasks])
```

## Targets

One source, many emitters. The authoritative list of flags and outputs is the usage header of
the build script — read it rather than trusting a copy here:

```
sed -n '/^# Usage/,/^$/p' web/bin/eddy-compile     # current flags + outputs
ls web/compiler/emit-*.bjs                          # one emitter module per target
```

Each `emit-*.bjs` is one projection of the graph (frontend, SQL, server, tests, Nix, claims
IR, MCP catalog, …). `--all` runs them together; `--migrate old.eddy new.eddy` diffs two
schemas into a migration.

## Live feeds and external panes

`(persist :feed "http://host/endpoint")` makes a store mirror a remote endpoint with real-time
per-row push (diff-by-identity) instead of `localStorage`; feed-mode stores are read-only.
For views Eddy can't express, `(panel name :mount "js.fn")` hands a pane to your own
JavaScript, and generated apps expose a `window.eddy` bus (ready signal, selection, feed
deltas) so mounted panes share the app's state. Working examples: `web/demo/fleet.eddy`
(a live agent observatory) and `web/demo/schema.eddy`.

## Claim-backed store

`web/runtime/claim-store.js` is a drop-in for the generated store with the same interface, but
internally an append-only claim log (subject predicate object) with supersession: `update` is
a superseding claim (history intrinsic), `delete` a tombstone, `snapshot()` persists the whole
log. Its own header comment is the source of truth for the semantics.

## Why

shadcn moved ownership from libraries back into your repo: stop importing black-box components,
own the code. Eddy applies the same idea one level up: stop importing a framework runtime, own
the app output.

## Build & test

```
cd web
bin/eddy-compile demo/tracker.eddy out/app.js   # compile the compiler, then build one app
bin/eddy-compile                                 # (no args) just rebuild compiler modules
npx playwright test                              # run the suites under tests/
node --test runtime/claim-store.test.mjs         # claim-store semantics
```

`eddy-compile` self-hosts: it compiles the `.bjs` compiler sources to JS (via Beagle — a bun
fast path, else Racket via the flake), then runs them. It picks the toolchain at runtime; you
don't choose.

## Pipeline

The stage *shape* is stable; the exact module roster is whatever `ls web/compiler/` shows.

```
.eddy → parse (sexpr) → read to IR → expand views → CHECK graph → project to N targets
```

The checker (`compiler/graph.bjs`) is the chokepoint: every emitter consumes the same checked
graph, which is why the projections stay consistent.

## Layout

`ls` is the index; this is just the orientation.

```
web/compiler/   the compiler, self-hosted in Beagle/JS (.bjs)
web/bin/        eddy-compile (build entry, all targets) + helpers
web/demo/       example .eddy sources — the canonical, runnable syntax reference
web/runtime/    claim-backed drop-in store
web/tests/      Playwright suites
web/public-js/  generated frontend artifacts
docs/adr/       architecture decisions  ·  docs/devlog/  build log  ·  docs/experiments/  spikes
```

## Dependencies

- [Beagle](https://github.com/tompassarelli/beagle) — typed authoring layer; compiles the `.bjs` sources (bun fast path, or Racket via the flake)
- Node — runs the compiled compiler and generated apps
- Playwright — testing

Exact pinned versions live in `web/package.json` and `web/flake.lock`, not here.
