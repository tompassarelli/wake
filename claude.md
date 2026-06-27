# Wake

Projection compiler: `.wake` declarations → a checked entity graph → many targets
(direct-DOM JS, SQL, server, tests, …). Thesis & invariants:
`docs/adr/0001-wake-is-a-projection-compiler.md`. Chronological why: `docs/devlog/`.

<!-- beagle -->
## Beagle

The compiler is authored in [beagle](https://github.com/tompassarelli/beagle) — a typed
authoring layer for Clojure/JS/Nix. Full language reference: `.claude/beagle-context.md`.

- `beagle check .` — type-check
- `beagle build . --out .build/` — compile
- `beagle sig fn-name .` — a function's type signature
- `beagle fields Record .` — record fields + accessors

The daemon (`beagle-daemon start --watch .`) gives instant type feedback after each edit via
the PostToolUse hook.
<!-- /beagle -->

## Build & test

The build script's own usage header is the source of truth for flags and outputs — read it,
don't trust a copy:

```
sed -n '/^# Usage/,/^$/p' web/bin/wake-compile
```

Typical loop (from `web/`):

```
bin/wake-compile demo/<app>.wake out/app.js   # rebuilds compiler modules, then emits
npx playwright test                            # or a single tests/<name>.spec.ts
```

`wake-compile` recompiles the `.bjs` sources every run and self-selects its toolchain
(bun-beagle fast path, else Racket via the flake) — you don't pick. After editing a `.bjs`,
just rebuild and run tests. Validate a `.bjs` with `racket <file>` to catch paren errors
before chasing a logic bug.

## Where things live

`ls web/compiler/` is the real index. The durable roles (these change slowly; the file roster
does not):

| Anchor | Role |
|--------|------|
| `compiler/sexpr.bjs` | s-expression parser |
| `compiler/reader.bjs` | `.wake` → IR (`compiler/ir.bjs` defines the IR records) |
| `compiler/ui.bjs` | view expansion (list-detail, selection) |
| `compiler/graph.bjs` | **the checker** — every emitter consumes this one checked graph |
| `compiler/codegen.bjs` | IR → direct-DOM JS (builds JS via `compiler/js-ast.bjs`) |
| `compiler/emit-*.bjs` | one projection each (SQL, server, tests, nix, claims, mcp, …) — `ls` them |
| `bin/wake-compile` | build entry; wires modules + every emit target |
| `runtime/claim-store.js` | claim-backed drop-in store (its header explains the semantics) |
| `demo/*.wake` | canonical, runnable syntax reference — read these, not prose, for syntax |
| `tests/*.spec.ts` | Playwright suites — `ls` for the current set |

`public-js/app.js` and everything under `out/` are **build artifacts** — never hand-edit;
change the `.wake` source or the codegen.

## Architecture

Codegen emits plain JS with zero runtime. The graph is checked once, then every target is a
projection of it — that's why a single field edit propagates to schema, server, and tests
together. Frontend patterns (compiled per-attribute DOM mutation, `when` conditional branches
via comment anchors, compile-time-traced derived fields, FK propagation, undo/redo over an
event log, split-pane selection) are realized in `codegen.bjs`; read it as the spec.

Live/seam features (real, see the demos for syntax): `(persist :feed "http://…")` mirrors a
remote endpoint with real-time per-row push (read-only stores); `(panel name :mount "js.fn")`
is the escape hatch to mount external JS; generated apps expose a `window.wake` bus (ready
signal, selection, feed deltas) so mounted panes share state. Demos: `demo/agents.wake`,
`demo/schema.wake`.

## Authoring rules

- Author the compiler in Beagle/JS (`.bjs`). Fix emitter bugs **upstream** in `~/code/beagle`,
  never by patching generated output.
- Generated files (`public-js/app.js`, `out/*`) are artifacts — edit source, not output.
- Beagle compiler + docs: `~/code/beagle/`.

## Beagle heredocs in emitters

When emitting multi-line JS/SQL/Nix from a `.bjs`, use Beagle `#<<TAG` heredocs for static
boilerplate instead of escaped `(str "...\n" ...)` chains. Dynamic parts (store names, field
refs, generated identifiers) stay as `(str ...)`. The closing tag's indentation sets the
dedent baseline.

```scheme
;; Good: heredoc for the static block
(let [preamble #<<JS
  const root = document.getElementById('app');
  const container = document.createElement('div');
        JS
      ]
  (str preamble "\n" dynamic-part))

;; Bad: escaped string soup
(str "  const root = document.getElementById('app');\n"
     "  const container = document.createElement('div');\n")
```
