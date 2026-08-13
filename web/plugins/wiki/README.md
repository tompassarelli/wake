# wake-wiki

`wake-wiki` is Wake's first-party revisioned-document plugin. It contributes a
stable resource, immutable revisions, draft and published pointers, five
invariant-bearing commands, bounded reads, explicit capabilities, and opt-in
baseline pages. It is declarative compile-time input. It is not a runtime
plugin loader, persistence adapter, authentication policy, Markdown parser, or
product theme.

The package ID is `wake-wiki`. Plugin ABI, public contract, and durable schema
are all version 1. The consuming application's immutable ID scopes storage;
lexical aliases, import aliases, display labels, package versions, and hostnames
never participate in storage identity.

## Materialization status

`plugin.bjs` materializes both durable entities, the three-state revision
lifecycle, all five invariant-bearing commands, all eight exported named
queries, the closed `SafeDocument` value type and provider port, and all twelve
exported UI components. A neutral substrate fixture is packed, digest-pinned,
linked, checked, and emitted as a FRAM plan in the package tests. `review` returns the
current draft half; a host composes it with `read-published` at the same served
snapshot because named-query ABI 1 has no optional joined binding. History is
split into `history-current` and `history-superseded`: the host reads the exact
current published revision first and then pages every superseded revision for
the same resource at that served snapshot. This is complete for K0's three-state
lifecycle without pretending the current query ABI has optional joins or
recursive lineage.

The history API keeps one stable response shape:
`{current, revisions, page, servedVersion}`. On the first page it executes
`history-current` and then `history-superseded` at that version. On a
continuation it executes `history-superseded` with the opaque cursor first,
then re-reads `history-current` at the cursor response's served version. It
includes `current` on every page and rejects any version disagreement; a
continuation never samples current head before opening its snapshot-pinned
cursor.

All operation exports are checked declarations, not callbacks or a
package-local mini-language. The twelve capabilities remain declarations,
never grants; the application binds policy before an operation becomes
reachable.

## Fixed storage roles

| Role | Storage ID |
|---|---|
| resource entity | `wake-wiki/entity/resource` |
| resource identity | `wake-wiki/field/resource/id` |
| resource published pointer | `wake-wiki/field/resource/published-revision` |
| resource draft pointer | `wake-wiki/field/resource/draft-revision` |
| revision entity | `wake-wiki/entity/revision` |
| revision identity | `wake-wiki/field/revision/id` |
| revision owner | `wake-wiki/field/revision/resource` |
| revision base | `wake-wiki/field/revision/based-on` |
| replaced draft | `wake-wiki/field/revision/replaces-draft` |
| revision state | `wake-wiki/field/revision/state` |
| revision author | `wake-wiki/field/revision/author` |
| revision creation time | `wake-wiki/field/revision/created-at` |
| revision publication time | `wake-wiki/field/revision/published-at` |
| revision payload digest | `wake-wiki/field/revision/digest` |
| revision links | `wake-wiki/field/revision/links-to` |
| revision title | `wake-wiki/field/revision/title` |
| revision summary | `wake-wiki/field/revision/summary` |
| revision content source | `wake-wiki/field/revision/content-source` |
| receipt resource result | `wake-wiki/field/receipt/result-resource` |
| receipt revision result | `wake-wiki/field/receipt/result-revision` |

The application may add immutable revision fields and immutable server-injected
receipt fields through the two exported extension ports. Every added field has
an application-owned explicit storage ID. Version 1 exposes no resource-field
extension: the resource remains an identity and two command-only pointers.

## Required configuration

The application binds these roles to lexical aliases:

```text
resource                         resource-id
revision                         revision-id
published-pointer                draft-pointer
owner-field                      base-field
replaces-field                   lifecycle-type
state-field                      actor-entity
author-field                     created-at-field
published-at-field               digest-field
links-field                      title-field
summary-field                    content-source-field
receipt-result-resource-field    receipt-result-revision-field
content-provider                 draft-state
published-state                  superseded-state
content-limits                   query-limits
safe-document-limits
```

`actor-entity` targets an application-owned authenticated actor entity with one
immutable identity. Lifecycle values are three distinct application values and
must realize this graph:

```text
draft -> published | superseded
published -> superseded
superseded ->
```

All limits are finite and required. There is no unbounded default.
Caller-selected page limits cannot exceed 247 rows, link lists cannot exceed
200 anchors, and configured safe-document limits have a minimum depth of 5 and
cannot exceed FRAM's absolute
1,048,576-byte, 256-depth, and 65,536-Term ceilings. A consuming application is
expected to bind materially tighter product and HTTP budgets; these absolute
plugin ceilings do not make a large provider result safe for a particular
response envelope. Compilation instantiates the exported `SafeDocument`
descriptor with those application-bound limits, so command validation, public
query hydration, and the generated browser codec all enforce the same envelope.

## Public operations

Commands:

| Name | Required semantic input |
|---|---|
| `create-resource-draft` | revision payload |
| `start-revision-draft` | resource, nullable expected published revision, payload |
| `replace-draft` | resource, expected draft, nullable expected published revision, payload |
| `abandon-draft` | resource, expected draft, nullable expected published revision |
| `publish` | resource, candidate, expected draft, nullable expected published revision, expected candidate digest, expected normalized links |

A revision payload contains title, summary, content source, bounded stable
resource links, and the closed record produced by the revision-field extension.
The runtime invocation envelope separately requires a portable idempotency
request ID; it is not a field in the normalized semantic command input.
The host injects actor, generated IDs, canonical time, payload digest, lifecycle
values, and pointers. Every result is recovered through the atomic Wake command
receipt and contains receipt ID, resource ID, revision ID, creation time, and
the checked receipt extension projection.

Queries:

| Name | Contract |
|---|---|
| `browse-published` | narrow page of current published resources |
| `read-published` | one current published revision rendered as safe blocks |
| `read-source-for-draft` | raw current published revision for an authorized new draft seed |
| `read-draft` | current draft and raw source for authorized editing |
| `review` | nullable published base and current draft at one snapshot |
| `history-current` | exact current published revision for snapshot pinning |
| `history-superseded` | every superseded revision owned by the resource |
| `backlinks` | current published sources linking to one published target |

`published-at` is absent from every draft and is set once, under an absent-value
guard, in the same transaction that first publishes a revision. Superseded
history requires that provenance field, so an abandoned or replaced draft can
never join merely because it shares the terminal lifecycle state.

Browse, superseded history, and backlinks use bounded opaque-cursor pages.
Published reads never expose draft or superseded content. A link to an unpublished resource is
an unavailable marker containing only its stable resource ID. Review is the
version-1 comparison surface; there is no separate comparison query.

Capabilities are declarations, never grants:

```text
wake-wiki/cap/browse-published
wake-wiki/cap/read-published
wake-wiki/cap/read-draft
wake-wiki/cap/review-draft
wake-wiki/cap/read-history
wake-wiki/cap/read-backlinks
wake-wiki/cap/create-draft
wake-wiki/cap/start-draft
wake-wiki/cap/replace-own-draft
wake-wiki/cap/abandon-own-draft
wake-wiki/cap/abandon-any-draft
wake-wiki/cap/publish-draft
```

The own-draft operations retain an actor-equals-author guard. Administrative
abandon uses the same pointer, ownership, state, and atomicity guards under its
separate audited capability.

## Ports

Version 1 exports exactly one plugin-specific provider port:

```text
wake-wiki/provider/content-parser
  input  {contentSource, safeDocumentLimits}
  output SafeDocument
```

The provider is application-bound and receives neither FRAM nor ambient host
authority. A successful receipt lookup precedes provider invocation. Output is
validated as a closed bounded safe-block tree before a write or viewer result.
The first contract includes paragraph, heading, block quote, list, code block,
thematic break, text, emphasis, strong text, inline code, safe link, and line
break nodes. Raw HTML, SVG, images, styles, event handlers, and trusted strings
are absent.

[`SAFE-DOCUMENT.md`](SAFE-DOCUMENT.md) freezes the exact v1 tag and field
spelling consumed by providers and generated clients. The checked component
DSL has no SafeDocument rendering intrinsic in ABI 1, so the baseline page
exposes a neutral container while an application shell uses the generated
`renderSafeDocument` browser binding. It never falls back to rendering raw
source or stringifying the provider object.

The only application data extension ports are:

```text
wake-wiki/extend/revision-fields
wake-wiki/extend/receipt-fields
```

The only route templates are `browse`, `new`, `read`, `edit`, `review`, and
`history`. The package exports baseline components with matching names plus
`resource-card`, `revision-summary`, `safe-document`, `link-list`,
`backlink-list`, and `conflict-notice`. Nothing is mounted by importing the
plugin. The application explicitly supplies concrete paths and may replace a
page with a type-compatible checked component.

Search, graph traversal, assets, retirement, restore, mutable ACLs, custom
resource fields, runtime hooks, arbitrary query extensions, assistant behavior,
and a general presentation-slot framework are deliberately outside K0.

## Neutral fixture

`fixtures/handbook/` binds the contract without Greywrought concepts. It uses
entries and editions, maps lifecycle values to `working`, `released`, and
`withdrawn`, adds one `audience` revision field and one server-injected release
policy digest receipt field, binds a plain-text safe-content provider, and
mounts all six routes explicitly.
