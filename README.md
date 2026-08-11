# Wake

Wake is an application compiler: `.wake` declarations become a checked
application graph, direct-DOM JavaScript, and a FRAM deployment plan.

Wake is deliberately not a browser framework. Generated applications use plain
DOM nodes and ordinary JavaScript. Wake checks the application once and projects
that graph onto each output, so the UI and data boundary describe the same
entities and fields.

## Status

Wake currently has two explicit data modes:

- `(persist :localStorage "key")` generates a self-contained browser
  application whose data authority is local storage.
- `(backend :fram)` generates a browser connector and `app.fram.json` for a
  Wake gateway backed by FRAM.

The local mode is the established compiler path. The FRAM path is a first
end-to-end slice for list/get, policy-checked writes, atomic domain commands,
and occurrence-version change polling. It intentionally does not yet provide
generic delete, remote undo, raw FRAM queries from the browser, or push
subscriptions. Change refresh is currently entity-granular.

`wake:web/demo/wiki.wake` is the canonical FRAM example and pressure test.

## Why FRAM is a boundary, not another Wake store

Wake owns application shape, application-schema validation, UI projection, the
closed command/query surface, and the authorization seam. The FRAM kernel stays
schema-neutral and owns recursive Terms and Triples, occurrence versions,
history, and Datalog. FRAM's official Node client supplies occurrence-correct
atomic identity uniqueness, create/upsert, and guarded field replacement. Wake
does not reproduce those storage semantics in JavaScript. Multi-entity domain
commands use the client's guarded atomic batch operation; publication policy
and lifecycle meaning remain in Wake.

```text
.wake source
    │
    ▼
checked Wake graph
    ├── direct-DOM JavaScript ──► browser
    └── FRAM plan ──────────────► Wake gateway ──► FRAMRPC ──► FRAM
```

The browser never speaks FRAMRPC and cannot submit arbitrary FRAM queries. The
runtime HTTP adapter exposes only the operations in the checked application
boundary, accepts POSTed JSON, and denies requests unless its host supplies an
authorizer.

## FRAM example

Every FRAM-backed entity has exactly one identity field. References name their
target entity, and `:many` selects multi-cardinality. Fields default to
`:write :set`; `:create` makes revision content immutable after creation, and
`:command` reserves invariant-bearing fields for a declared domain command.
Identity fields are always immutable:

```scheme
(ns wake.wiki)
(backend :fram)

(defstate RevisionStatus
  [:draft -> :canonical :obsolete]
  [:canonical -> :obsolete]
  [:obsolete ->])

(entity page
  (slug : String :identity)
  (title : String)
  (canonical-revision : Ref :to revision :write :command))

(entity revision
  (id : String :identity)
  (page : Ref :to page :write :create)
  (body : String :write :create)
  (status : RevisionStatus :write :command)
  (links-to : Ref :to page :many :write :create))

(publication canonical
  :owner page
  :pointer canonical-revision
  :revision revision
  :owner-field page
  :state-field status
  :draft :draft
  :published :canonical
  :retired :obsolete)
```

The FRAM projection turns each identity into a recursive subject Term and each
field into a predicate Term. The gateway then maps named Wake operations onto
FRAM schema and occurrence operations through the official Node client. A
publication swaps the owner's pointer, publishes the candidate, and retires
the prior revision in one occurrence-correct guarded batch.

## Local example

Local applications keep the existing direct-DOM and local event-store path:

```scheme
(ns wake.tracker)
(persist :localStorage "wake-tracker")

(entity task
  (title : String)
  (done : String))

(component task-row
  :props [title done]
  (div
    (span :text title)
    (when done (span :text "Done"))))

(view tasks
  :entity task
  :each task-row
  :add-form [title done]
  :title "Tasks")
```

`backend` and `persist` declare different authorities and cannot be combined.

## Build and test

Run these commands from `wake:web/`:

```sh
npm install
./bin/wake-compile
./bin/wake-compile demo/tracker.wake out/app.js
./bin/wake-compile --fram demo/wiki.wake out/app.fram.json
./bin/wake-compile --all demo/wiki.wake out/wiki
npm test
npm run test:browser
```

Browser tests use `WAKE_PLAYWRIGHT_EXECUTABLE_PATH` when set, otherwise the
NixOS system Chrome when present, and otherwise Playwright's bundled Chromium.
Install that fallback once with `npx playwright install chromium`.
The `test:browser` runner chooses a free high local port for each invocation;
direct Playwright commands use port 8080 unless `WAKE_BROWSER_PORT` is set.

`test:browser` compiles the CRM, todo, tracker, and wiki demos concurrently into
a private temporary fixture directory, syntax-checks the emitted JavaScript,
and then runs their Playwright suites. It never reads tracked generated apps or
a preexisting `/tmp` fixture.

The compiler flags are summarized in the usage header of
`wake:web/bin/wake-compile`. With no output path, a single target writes to
standard output. `--all` writes exactly:

- `app.js`
- `app.fram.json`

`wake-compile` recompiles the Beagle/JS compiler modules in private temporary
staging before emitting an application. With no arguments, it only verifies
that every compiler module builds. Beagle and Node are development dependencies;
a deployed FRAM-backed application additionally needs FRAM and a host for the
Wake gateway.

## Pipeline

```text
.wake → s-expression parser → IR → UI expansion → checked graph → emitters
```

`wake:web/compiler/graph.bjs` is the semantic chokepoint. All emitters consume
its checked graph. FRAM-specific invariants, including one identity per entity
and resolved reference targets, are checked there before output is produced.

## Layout

- `wake:web/compiler/` — compiler sources in Beagle/JS.
- `wake:web/compiler/codegen.bjs` — direct-DOM JavaScript projection.
- `wake:web/compiler/emit-fram.bjs` — deterministic FRAM plan projection.
- `wake:web/runtime/fram-gateway.mjs` — plan-driven FRAM application gateway.
- `wake:web/runtime/fram-http.mjs` — closed HTTP adapter and authorization seam.
- `wake:web/demo/` — compiler-checked examples; `wiki.wake` is the FRAM fixture.
- `wake:web/tests/` — handwritten compiler-plan, wiki, and browser tests.
- `wake:web/public-js/` — the browser-test HTML shell and shared CSS.

Generated files under `wake:web/out/` are artifacts. Browser test applications
are temporary. Edit `.wake` or `.bjs` sources instead of retaining generated
JavaScript.

## License

Wake is available under the MIT License or Apache License 2.0, at your option.
See `wake:LICENSE`.
