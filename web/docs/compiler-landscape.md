# Compiler Landscape Research

Research from reading the source code of SolidJS, Svelte 5, Marko,
Wasp, and Electric Clojure. All projects cloned to ~/code/ as of
2026-05-20 for study. This document describes ideas and techniques
in our own words with attribution — no code is reproduced or copied
into Wake.

## What we studied and why

| Project | License | Why it matters to Wake |
|---------|---------|------------------------|
| Marko (eBay) | MIT | Per-input apply functions, flat scope objects, walk-based DOM traversal |
| SolidJS | MIT | Fine-grained reactive graph algorithm, conditional/list compilation |
| Svelte 5 | MIT | Runes compiler, batch scheduling, write-version dirty tracking |
| Wasp | MIT | DSL → full-stack via central IR, generator architecture |
| Electric Clojure | EPL-2.0 | Single-source → multi-target, reactive boundary inference |

## Convergent patterns

These are ideas where multiple projects independently arrived at the
same solution. Convergence is a strong signal that the approach is
correct.

### 1. Per-attribute update functions are the right primitive

Marko generates separate "apply functions" per input prop. When a
parent's `text` prop changes, only the `$text` function runs — the
`$onClick` function is untouched. SolidJS wraps each dynamic
expression in its own reactive effect. Svelte 5 generates per-rune
update code via write-version tracking.

**Wake already does this.** Our codegen emits per-attribute update
functions (`update.name(v)`, `update.email(v)`) that directly mutate
the specific DOM node. This is validated by three independent
production frameworks arriving at the same design.

### 2. Flat scope objects beat closures

Marko's most distinctive architectural choice: all reactive state lives
in flat "scope objects" with integer-encoded property keys instead of
JavaScript closures. A component's state is `scope.a`, `scope.b`, not
variables captured in nested function closures.

Benefits: lower memory (one object vs N closures), predictable GC
(single object lifecycle), and the scope can be serialized for
hydration. Marko even encodes accessor names as single characters
(`a`-`z`, then `a0`-`z9`) to minimize bundle size.

SolidJS uses closures (each `createRoot` gets its own closure scope).
Svelte 5 uses Proxy-wrapped state objects. The Marko approach is the
most radical and the most relevant to Wake because we're doing
whole-program compilation — we control the entire output and can choose
the representation.

**Wake implication:** Our generated components currently use closures
(the `el_0`, `el_1` variables inside each `_create` function). For
Phase 2 components that need cross-boundary updates, consider a flat
scope object per component instance. This would make it easier to:
- Serialize component state (for SSR/hydration later)
- Share update functions across component boundaries
- Reduce closure overhead for large component trees

### 3. Three-state dirty tracking for reactive graphs

SolidJS, Svelte 5, and Leptos all converged on the same algorithm
(originally from the "Reactively" library):

- **Clean**: no update needed
- **Check** (SolidJS: PENDING, Svelte: MAYBE_DIRTY): upstream changed,
  but this node hasn't verified yet whether its value actually changed
- **Dirty** (SolidJS: STALE, Svelte: DIRTY): definitely needs recomputation

The Check state solves the "diamond problem" efficiently: when A
depends on both B and C, and both B and C depend on D, changing D
marks B and C as Dirty but marks A as only Check. A doesn't recompute
until it pulls from B and C and confirms the value actually changed.

**Wake implication:** We don't have a runtime reactive graph — our
update paths are compiled away. But derived fields with diamond
dependencies (field X depends on fields A and B, which both depend on
field C) would benefit from this pattern. Currently derived fields
recompute eagerly. For Phase 2, if we add more complex derived
chains, the three-state model prevents redundant DOM updates.

### 4. Central IR → multiple generators is proven

Wasp's `AppSpec` is exactly analogous to Wake's entity graph: a
single intermediate representation consumed by independent generators
(DbGenerator, ServerGenerator, SdkGenerator, WebAppGenerator).
Electric Clojure builds a triple-store DAG that gets sliced into
client and server code. Both validate Wake's architecture.

Wasp's generators are pure functions: `AppSpec → [FileDraft]`. File
drafts are abstract (template, copy, text) and written atomically.
This prevents partial builds and makes generators independently
testable.

**Wake already does this** — our emitters are pure functions from
entity graph to string output. The file-draft pattern could be useful
if we add error recovery to the build.

### 5. Template cloning for DOM creation

SolidJS and Svelte both extract static HTML into `<template>` elements
and clone them at runtime (`cloneNode(true)`). Marko uses HTML strings
with encoded "walk instructions" — compact character sequences that
describe DOM traversal paths (`firstChild`, `nextSibling`, etc.).

All three avoid `document.createElement` for static structure because
cloning a pre-parsed template is faster than building the DOM
imperatively.

**Wake implication:** We currently emit `document.createElement` for
everything. Template cloning would be a straightforward optimization:
extract the static DOM structure into a template string, clone it,
then walk the cloned tree to find the dynamic nodes. The walk approach
(Marko-style) is particularly elegant — instead of `getElementById`
or `querySelector`, you navigate by structure. Not urgent, but worth
doing when we optimize output size.

## Divergent approaches

These are places where projects make fundamentally different choices.
The differences illuminate the design space.

### Conditional rendering

**SolidJS** — `<Show>` creates a memo that evaluates the condition.
Two modes: non-keyed (only re-renders when truthiness flips, child
gets an accessor) and keyed (re-renders on any value change, child
gets the raw value). Branch swap destroys the old reactive scope and
creates a new one.

**Svelte 5** — `{#if}` compiles to an effect with a branch function.
Each branch is a thunk `($$render) => { ... }`. A BranchManager
tracks which branch is active and handles lifecycle (destroy effects
of inactive branches, create new ones).

**Marko** — conditional tags use scope-based branch tracking. The
scope itself carries the branch state.

**Wake implication for Phase 2:** Our `(when condition body)` should:
1. Wrap the condition in a derived/memo to avoid re-evaluating it on
   every upstream change
2. Create/destroy the branch DOM and its reactive scope on transitions
3. NOT use show/hide (we already learned this lesson with Tailwind's
   `display: flex` overriding `hidden`)

The SolidJS keyed vs non-keyed distinction matters: if the condition
value is used inside the branch (e.g., `(when selected-item ...)`),
we want keyed behavior (re-render when the item changes). If it's a
boolean gate, non-keyed is more efficient.

### List rendering and reconciliation

**SolidJS** — `<For>` tracks items by referential identity. Each item
gets its own reactive scope (`createRoot`). When the array changes,
it diffs by reference: skip common prefix, skip common suffix, build
a Map of references for the middle section, reuse existing
computations for items that moved. `<Index>` is the inverse: keyed by
position, updates values in-place via signals.

**Svelte 5** — `{#each}` uses a reconciliation algorithm with
configurable keying. Supports animated transitions on add/remove.

**Wake implication for Phase 2:** For `(each entity-store row-component)`:
- Each row should get its own scope (like SolidJS createRoot)
- Use entity ID as the key (natural identity)
- On store changes, only create/destroy/reorder affected rows
- The current approach (rebuild all rows on `load` event) is correct
  for initial load but expensive for incremental updates

For the large-list problem (~450K rows), none of these frameworks
solve it with reconciliation — they all assume reasonable list sizes.
Virtual scrolling or server-side pagination is the answer there.

### Client/server boundary

**Electric Clojure** — the most ambitious: infers the boundary from
symbol resolution. If code references a JVM class, it runs on the
server. If it touches the DOM, it runs on the client. Closures can
span both. The compiler builds a reactive DAG where every node has a
site annotation, then emits dual code that shares constructor indices
so both peers agree on "what function is at index 0."

**Wasp** — explicit boundary: entities defined in Prisma flow through
the AppSpec to separate generators. Frontend and backend are fully
separate codegen passes.

**Wake** — also explicit: the entity graph feeds independent emitters.
Each emitter reads the same graph but produces completely different
output. No inference needed because the emitters know their target.

Electric's approach is fascinating but overkill for Wake. Our entity
graph already captures everything both sides need. We don't need
inference because we're not compiling arbitrary code — we're compiling
declarations.

## Ideas worth adopting

Ranked by relevance to Phase 2:

### 1. Branch scoping for conditionals (from SolidJS + Svelte)

When a `(when)` block activates, create a fresh scope. When it
deactivates, destroy it (remove DOM nodes, cancel any watchers). This
is cleaner than show/hide and handles cleanup automatically.

Implementation: each `(when)` compiles to a function that returns
`{ el, update, destroy }` — same shape as our components. The
condition watcher calls `destroy()` on the old branch and mounts the
new one.

### 2. Flat scope objects for components (from Marko)

Instead of closures inside `component_create(props)`, generate a
scope object: `{ el: rootNode, n0: textNode, n1: spanNode, ... }`.
Update functions become `(scope, value) => { scope.n0.textContent = value }`.

This makes cross-component update propagation trivial: parent holds a
reference to child scope and calls child's update functions directly
with the scope. No need to thread closures.

### 3. Keyed vs non-keyed conditional modes (from SolidJS)

For `(when selected-item detail-component)` — re-render the detail
when the selected item changes (keyed). For `(when show-sidebar sidebar)` —
only toggle on boolean change (non-keyed). The compiler can infer
which mode based on whether the condition value is used inside the
body.

### 4. Walk-based DOM node references (from Marko)

Instead of assigning each `createElement` result to a variable, clone
a template and walk the tree with `firstChild`/`nextSibling` to find
dynamic nodes. Produces smaller output and faster initialization.

Not urgent — our current approach works. But for production bundles
with many components, this significantly reduces output size.

### 5. Write-version tracking (from Svelte 5)

Svelte assigns a monotonically increasing "write version" to each
state change. A derived value stores the write version of its last
computation. To check if it's dirty, compare versions — O(1) instead
of scanning dependency arrays. Simple, cache-friendly.

Useful if we add runtime-tracked derived fields beyond what compile-
time tracing handles.

## Ideas we should NOT adopt

### Runtime reactive graph (SolidJS, Svelte, all of them)

Every framework maintains a runtime dependency graph with subscription
management, cleanup, disposal, etc. This is the framework runtime that
Wake eliminates. Our compile-time tracing means we know exactly which
DOM node to update for each attribute change — no runtime bookkeeping.

Don't add a reactive runtime. The whole point is that the compiler
does this work.

### Proxy-based state (Svelte 5)

Svelte wraps `$state` objects in JavaScript Proxies to intercept
property access. This enables fine-grained tracking without explicit
signals but has overhead and edge cases (Proxy identity, non-
configurable properties). Our entity stores with explicit update
events are simpler and more predictable.

### Inferred client/server boundary (Electric)

Elegant but unnecessary for Wake. Our entity graph is the boundary —
the same declaration feeds both sides. No inference needed.

## Where Wake is genuinely novel

After reading five compiler codebases:

1. **No other project compiles from one declaration to 5+ targets.**
   Wasp comes closest (3 generators) but emits framework code (React),
   not compiled-reactive DOM. Electric does client+server but not
   SQL/tests/Nix.

2. **No other project achieves zero runtime with compiled per-attribute
   reactivity.** SolidJS has a reactive runtime (~7KB). Svelte has one
   (~15KB). Marko has one. Wake's output is self-contained — no
   imports, no framework, no runtime overhead.

3. **Brownfield DB mapping as a compiler concern.** No framework treats
   legacy schema mapping (`:table`, `:column` annotations) as
   something the compiler handles. Everyone assumes greenfield or
   delegates to an ORM layer.

4. **The entity graph IS the IR.** Other projects have separate
   concepts for "data model" and "compiler IR." In Wake, the entity
   graph is both — attributes, types, constraints, FK relationships,
   state machines, all in one graph that every emitter reads.

## Connection to CNF

"Graph the meaning. Compile the motion."

Wake's entity graph is a specialized instance of Claim Normal Form's
general claim graph. The entity graph captures meaning (relationships,
constraints, types, component bindings). The emitters compile the
motion (DOM operations, SQL queries, HTTP handlers, test assertions).

The architectural move is the same one CNF describes for programs
generally: canonical representation in the graph, text/code as
projection. Where CNF says `graph → Racket | TypeScript | docs`,
Wake says `entity graph → app.js | server.js | schema.sql`.

This isn't coincidence — it's the same insight applied at different
scales.

## Recommendations for Phase 2

Based on this research:

1. **Conditionals** (`when`, `match`): Branch scoping with
   create/destroy lifecycle. Keyed mode when condition value is used
   inside the body. Compile-time tracing of which attributes trigger
   branch evaluation.

2. **Components**: Flat scope objects. Parent→child data flow via
   direct scope access. Each component returns `{ el, update, destroy }`
   like today, but update functions take `(scope, value)` instead of
   closing over DOM references.

3. **Dynamic lists**: Per-item reactive scopes keyed by entity ID.
   Incremental add/remove/reorder, not full rebuild. Compile-time
   tracing still works — each row component's update functions are
   known at compile time.

4. **Routing**: Already working (view containers with style.display
   toggling). Could upgrade to branch scoping for lazy initialization
   of views.

5. **Don't add a runtime.** The compile-time approach is validated by
   being the direction all these frameworks are moving toward — but
   none of them have fully eliminated the runtime yet. Wake has.
   Keep it.

---

Projects cloned to ~/code/ for reference:
- ~/code/solidjs (MIT)
- ~/code/svelte (MIT)
- ~/code/marko (MIT)
- ~/code/wasp (MIT)
- ~/code/electric-clojure (EPL-2.0)
- ~/code/leptos (MIT/Apache-2.0)
