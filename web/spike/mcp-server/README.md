# mcp-server spike — an MCP host serving an wake `emit-mcp` catalog over Fram claims

Task #41. A **runnable MCP-server host** that serves an wake `emit-mcp` tool
catalog (`web/compiler/emit-mcp.bjs`) over a **Fram claim store**. The other half
of the projection: `emit-mcp` projects a schema into an MCP tool *surface*; this
host is the *dispatch core + claim-backed handlers* that actually answer
`tools/call`.

ADR 0001 — wake = projection compiler. The tool set falls out of the schema
mechanically (per entity: CRUD; per `:Ref` field: a transitive `*_closure`
query); every handler runs against a real claim store. No bespoke logic.

## Dogfood: the host is authored in BEAGLE (typed against the fram API)

`host.bclj` (`#lang beagle/clj`) is the **typed** dispatch core + handlers. The
fram API is now typed in beagle (`beagle-lib/private/stdlib-fram.rkt`), so the
claim calls type as the **real fram types** (Int ids, Bool, the Datalog
`(Map String (Set (Vec Any)))` shapes) — not `Any`.

```
~/code/beagle/bin/beagle check --agent spike/mcp-server/host.bclj   # => 0 errors
```

Handlers (reusing the proven shapes from `web/spike/mcp-projection/catalog.clj`
and `web/spike/wake-on-claims/store.clj`):

| op | handler | claim mechanism |
|----|---------|-----------------|
| `*.create` | `h-create-with-refs!` | `entity!` + a `claim!` per field; a `:Ref` field is an edge to the target entity |
| `*.get` | `h-get` | live field values via `by-lp` |
| `*.list` | `h-list` | live (non-tombstoned) members of a kind via `by-pr` |
| `*.update` | `h-update!` | a **superseding** claim (history kept) |
| `*.remove` | `h-remove!` | a tombstone claim (non-destructive) |
| `*_closure` | `h-closure` | a 2-rule **Datalog reaches** over the named edge predicate (scope-correct) |

MCP core: `tools-list` returns the catalog's tools; `tools-call!` dispatches and
wraps the result as `{:content [{:type "text" :text ...}]}`.

## Files

- `host.bclj` — the TYPED host (dispatch core + claim handlers + MCP result shape). Source of truth.
- `host.clj` — the beagle build artifact (`beagle build host.bclj host.clj`). What `bb` runs.
- `gate.clj` — the **runnable gate** (hard assertions, exit 1 on failure). Loads the catalog,
  drives `tools/list` + `tools/call` for create x2 + a relation edge + list + the `*_closure`
  tool over real fram, asserting correct results.
- `serve.clj` — the **bonus** thin MCP JSON-RPC stdin/stdout loop (`initialize` / `tools/list` /
  `tools/call`). The dynamic I/O boundary, gap-listed.
- `run.sh` — rebuild `host.clj` from `host.bclj`, generate the crm-v2 catalog, run the gate.

## Run

```
./run.sh                                   # rebuild host + gate over real fram (GATE PASS)
# bonus JSON-RPC server:
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | bb -cp ~/code/fram/out serve.clj
```

## The gap list (where Beagle can't express it — kept honest, not `Any`-washed)

The dynamic I/O envelope is **not** in `host.bclj`; it lives in `serve.clj`/`gate.clj`
as `.clj` on purpose. These are real gaps in the typed surface, not laziness:

1. **No stdin reader / line-seq loop** in the typed surface — the JSON-RPC read loop
   is `.clj`.
2. **No JSON codec** (parse/generate) typed in beagle — catalog parsing + wire framing
   are `.clj` (`cheshire`).
3. **No JSON-RPC notion** — request routing (`initialize`/`tools/list`/`tools/call`) is `.clj`.
4. **`field` / `h-get` values are `Any`** — a claim's literal is an open EDN union; fram
   itself types `c/literal` as `Any`. Justified at the fram boundary, not a smell.
5. **Catalog `inputSchema` field types** are flattened to `string` by `emit-mcp` (every
   MCP input is a string on the wire); the host doesn't re-derive richer types.
