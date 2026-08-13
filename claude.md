# Wake

Wake is a projection compiler:

```text
.bjs Beagle → typed Wake declarations → checked application graph → direct-DOM JS | FRAM plan
```

The checked graph is the authority. Do not let an emitter or runtime infer a
second schema.

## Authoring loop

The compiler is written in Beagle/JS. Before editing `.bjs`, run:

```sh
beagle doctor --deep
beagle langs --json
beagle check --agent web/compiler
```

Use canonical typed structure (`(name Type)` fields and parameters, with a
return type after the parameter vector), not legacy colon/arrow annotations.
After an edit, ask the compiler first:

```sh
beagle syntax web/compiler/FILE.bjs
beagle check --agent web/compiler
beagle fmt --check web/compiler
```

Run these Wake commands from `wake:web/`:

```sh
bun install --frozen-lockfile
./bin/wake-compile
./bin/wake-compile demo/tracker.bjs out/app.js
./bin/wake-compile --fram demo/wiki.bjs out/app.fram.json
./bin/wake-compile --all demo/wiki.bjs out/wiki
bun run test
bun run test:browser
```

The browser command is the fixture authority: it concurrently compiles the
current CRM, todo, tracker, and wiki sources into one private temporary
directory, checks each emitted file with Bun, and passes that directory to
Playwright. Tests must not read tracked generated JavaScript or fixed `/tmp`
paths.

`wake:web/bin/wake-compile` owns the current flags and module roster. Each
invocation stages modules in its own temporary directory, so parallel builds
must never share compiler staging. It uses the configured Beagle checkout; do
not invoke bare Racket or patch generated JavaScript.

## Source anchors

| Source | Responsibility |
| --- | --- |
| `wake:web/compiler/ir.bjs` | typed compiler IR records |
| `wake:web/compiler/checked-declarations.mjs` | checked Beagle bundles to typed Wake declarations |
| `wake:web/compiler/graph.bjs` | semantic validation and checked graph |
| `wake:web/compiler/ui.bjs` | UI expansion |
| `wake:web/compiler/codegen.bjs` | direct-DOM and browser connector output |
| `wake:web/compiler/emit-fram.bjs` | deterministic `app.fram.json` plan |
| `wake:web/runtime/fram-gateway.mjs` | checked-plan operations over the FRAM client |
| `wake:web/runtime/fram-http.mjs` | closed POST/JSON transport and authorization seam |
| `wake:web/demo/wiki.bjs` | canonical FRAM-backed application fixture |
| `wake:web/bin/wake-browser-test` | hermetic local-app browser fixture runner |

Generated output in `wake:web/out/` is never an edit target. The tracked files
in `wake:web/public-js/` are test-shell assets, not generated applications.

## Data authorities

Wake supports two deliberately separate application authorities:

- `(wake/->LocalStorageAuthority "key")` means browser-local data authority.
- `(wake/->FramAuthority "fram")` means FRAM data authority through the Wake gateway.

They cannot be combined. Retired alternative persistence and deployment
projections are not compatibility surfaces and must not return.

A FRAM-backed entity has exactly one stored `:identity` field. A `Ref` must
declare `:to ENTITY`; `:many` means multi-cardinality. The graph checker owns
these application-level invariants before any emitter runs.

## Separation of concerns

Wake owns:

- entity, field, reference, component, view, form, and route declarations;
- application-schema validation and compilation to the checked graph;
- deterministic subject and predicate templates in the FRAM plan;
- the named application query/command surface;
- browser cache synchronization and the host-provided authorization seam.

The schema-neutral FRAM kernel owns:

- recursive Term and Triple encoding;
- occurrence batches, versions, retractions, and history;
- Datalog evaluation and storage durability.

FRAM's official Bun client owns occurrence-correct atomic identity uniqueness,
create/upsert, and guarded field replacement.

If Wake needs to emulate a missing FRAM storage guarantee, stop and repair or
extend FRAM instead. The gateway translates application intent; it is not a
second database engine.

## Gateway contract

The browser-facing adapter accepts POST JSON only:

- `/api/wake/query`: `list` or `get` for a declared entity.
- `/api/wake/command`: `create`, `set`, or a declared atomic domain command.
- `/api/wake/changes`: changes after an occurrence-version cursor.

Requests have exact key sets and a bounded body. The adapter denies by default;
its host must provide an authorization callback. It exposes no raw FRAM query,
Term, schema, or transaction endpoint. Big integer versions cross JSON as
unsigned decimal strings.

The current browser connector loads entity rows, sends create/set/publication
commands, and polls changes. It refreshes an affected entity store as a unit
even though change records carry identities. Generic delete, remote undo, and
push subscriptions are not implemented yet.

## Compiler discipline

- Preserve the single checked-graph chokepoint. Add a graph field once, then
  update every in-tree consumer in the same change.
- Keep FRAM vocabulary out of ordinary UI declarations. Backend-specific
  lowering belongs in the plan emitter and gateway.
- Use Beagle heredocs for substantial static emitted text; keep dynamic pieces
  in explicit expressions.
- Fix Beagle parser, checker, or emitter defects upstream in Beagle before
  continuing Wake work.
- Run the nearest existing check once and report exactly what it observed.
