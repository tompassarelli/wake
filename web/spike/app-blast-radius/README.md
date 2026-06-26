# Spike: app-level blast radius is scope-correct

**The first falsifiable test of the wake × Beagle unification** ("the app falls out of
claims"). It proves *whether*, not *when*: does wake's app-claim graph yield a
**scope-correct** field-change blast radius — the app-level mirror of Beagle's
`mod_a/mod_b` cascade receipt (which proved graph-native repair beats regex on a
same-named collision)?

## The fixture

`demo/crm-v2-spike.wake` = `crm-v2` + **one decoy**: a `company` field on the `note`
entity. So two field nodes share the leaf name `company`:

- `contact.company` — the change target. `contact.display-name` is `(Derived (str name " @ " company))`, so it carries `["contact.display-name" "dep" "contact.company"]`.
- `note.company` — the **decoy**: same leaf name, different entity, **nothing derives from it** (no inbound `dep`/`fk-target` edge).

## The receipt

```
QUERY: change contact.company — what is the blast radius?
  NAIVE (bare leaf-name "company"):        (contact.company  note.company)
  GRAPH (reaches-closure over dep edges):  (contact.display-name)
  decoy note.company in GRAPH?  false   <- scope-correct, absent
  real  contact.display-name in GRAPH?  true
```

A bare-name (regex-style) pass drags in `note.company` — an unrelated entity's field.
The claim-graph closure (transitive `reaches` over `dep` edges, the same Fram Datalog
engine Beagle/Lodestar use) includes only the genuine dependent and **excludes the
decoy**. Kill-criterion #1 cleared: app-as-claims reasoning is scope-correct.

## Run it

```sh
./run.sh           # regenerates claims via `wake-compile --claims`, runs the gate
```

Exit 0 = scope-correct; exit 1 = the decoy leaked into the graph result (the
unification thesis is false — stop and rethink). Prereqs: `bb` (babashka) and fram
built at `$FRAM_OUT` (default `~/code/fram/out`). Wire `run.sh` into CI to keep the
boat burned — no future change may let a `contact.company` edit blast `note.company`.

## What it does NOT prove

Only the **reasoning** pillar at the app level (scope-correct blast radius). Not the
renderer, not effects, not authoring. Those are later moves. This is the cheap
load-bearing proof that the whole unification rests on.
