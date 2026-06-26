// Node test for the claim-backed gen-store drop-in. The JS analog of
// web/spike/wake-on-claims/store.clj: proves CRUD + intrinsic history +
// non-destructive delete + durable persist/reload, through the SAME interface
// gen-store exposes, so it is a genuine drop-in.  run:  node claim-store.test.mjs
import { claimStore } from "./claim-store.js";

let fails = 0;
const check = (name, ok) => { console.log(`  ${ok ? "[PASS]" : "[FAIL]"}  ${name}`); if (!ok) fails++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const s = claimStore();
const spec = s.add({ title: "write spec", status: "todo" });
s.add({ title: "build", status: "todo" });
s.add({ title: "ship", status: "todo" });
const junk = s.add({ title: "scratch", status: "todo" });

// edits + delete
s.update(spec.eid, "status", "doing");
s.update(spec.eid, "status", "done");
s.remove(junk.eid);

console.log("=== claim-store (claim-backed gen-store drop-in) ===");
console.log("  live titles:        ", s.all().map((e) => e.title));
console.log("  spec.status (live): ", s.get(spec.eid).status);
console.log("  spec.status history:", s.history(spec.eid, "status"));

check("CRUD: 3 live tasks (junk tombstoned)", eq(s.all().map((e) => e.title).sort(), ["build", "ship", "write spec"]));
check("update is a superseding claim: spec.status = 'done'", s.get(spec.eid).status === "done");
check("HISTORY FREE: todo+doing retained (superseded), done live",
  eq(s.history(spec.eid, "status"), [{ value: "todo", live: false }, { value: "doing", live: false }, { value: "done", live: true }]));
check("DELETE non-destructive: junk gone from all(), get()->undefined", s.get(junk.eid) === undefined && !s.all().some((e) => e.eid === junk.eid));

// durability: snapshot (the LOG) -> JSON -> reload into a fresh store
const persisted = JSON.parse(JSON.stringify(s.snapshot()));   // localStorage round-trip analog
const s2 = claimStore();
s2.load(persisted);
console.log("\n  reloaded live titles:", s2.all().map((e) => e.title));
console.log("  reloaded spec.status:", s2.get(spec.eid).status);
check("DURABLE: live state survives persist->reload", eq(s2.all().map((e) => e.title).sort(), ["build", "ship", "write spec"]));
check("DURABLE: spec.status='done' survives reload", s2.get(spec.eid).status === "done");
check("DURABLE: HISTORY survives reload (todo/doing still in the log)",
  eq(s2.history(spec.eid, "status"), [{ value: "todo", live: false }, { value: "doing", live: false }, { value: "done", live: true }]));

console.log(fails === 0
  ? "\nGATE PASS — claim-backed store is a drop-in for gen-store: CRUD + history + non-destructive delete + durable, in the browser."
  : `\nGATE FAIL — ${fails} check(s) failed.`);
process.exit(fails === 0 ? 0 : 1);
