// claim-store.js — a CLAIM-BACKED drop-in for eddy's generated gen-store (ADR 0001,
// the apps pillar). Same interface (add/get/update/remove/all/snapshot/load/watch) so
// the rest of a generated app works unchanged — but internally it is an append-only
// CLAIM LOG (subject predicate object) with supersession, not a mutable Map of objects.
//
// What that buys, in the actual browser app, for free:
//   - update is a SUPERSEDING claim — the old value stays (marked sup); HISTORY is intrinsic.
//   - delete is a tombstone claim — non-destructive.
//   - snapshot() returns the LOG, so localStorage persists history (not just current state);
//     load() replays it. (persist :localStorage) keeps the audit trail across reloads.
// This is the JS sibling of web/spike/eddy-on-claims/store.clj (which proves the same
// semantics against the real Fram engine). One store per entity type, exactly like gen-store.

export function claimStore() {
  let nextEid = 1, nextCid = 1;
  const claims = [];                 // {cid, l:eid, p:attr, r:value, sup:bool}
  const watchers = [];
  const notify = (evt) => { for (const fn of watchers) fn(evt); };

  const liveClaim = (eid, attr) => { // latest live claim for (eid, attr)
    let found = null;
    for (const c of claims) if (c.l === eid && c.p === attr && !c.sup) found = c;
    return found;
  };
  const tombstoned = (eid) => !!liveClaim(eid, "__tombstoned");
  const project = (eid) => {         // live claims -> a plain entity object {field: value, eid}
    const e = { eid };
    for (const c of claims) if (c.l === eid && !c.sup && !c.p.startsWith("__")) e[c.p] = c.r;
    return e;
  };
  const entityIds = () => {
    const seen = new Set(), out = [];
    for (const c of claims) if (!seen.has(c.l)) { seen.add(c.l); out.push(c.l); }
    return out;
  };

  return {
    add(fields) {
      const eid = nextEid++;
      for (const [k, v] of Object.entries(fields)) claims.push({ cid: nextCid++, l: eid, p: k, r: v, sup: false });
      const entity = project(eid);
      notify({ type: "add", eid, entity });
      return entity;
    },
    get(eid) { return tombstoned(eid) || !entityIds().includes(eid) ? undefined : project(eid); },
    update(eid, attr, value) {
      const old = liveClaim(eid, attr);
      if (old) old.sup = true;                              // supersede — old claim kept, marked not-live
      claims.push({ cid: nextCid++, l: eid, p: attr, r: value, sup: false });
      notify({ type: "update", eid, entity: project(eid), attr, old: old ? old.r : undefined, ["new"]: value });
    },
    remove(eid) {                                           // tombstone — non-destructive
      claims.push({ cid: nextCid++, l: eid, p: "__tombstoned", r: true, sup: false });
      notify({ type: "remove", eid });
    },
    all() { return entityIds().filter((e) => !tombstoned(e)).map(project); },
    watch(fn) { watchers.push(fn); },
    snapshot() { return { claims: claims.map((c) => ({ ...c })), nextEid, nextCid }; },  // the LOG (history-preserving)
    load(snap) {
      claims.length = 0;
      if (snap && Array.isArray(snap.claims)) {             // claim-log format (history preserved)
        for (const c of snap.claims) claims.push({ ...c });
        nextEid = snap.nextEid || (claims.reduce((m, c) => Math.max(m, c.l), 0) + 1);
        nextCid = snap.nextCid || (claims.length + 1);
      } else if (Array.isArray(snap)) {                     // legacy: array of entity objects
        for (const it of snap) { const { eid, ...fs } = it; for (const [k, v] of Object.entries(fs)) claims.push({ cid: nextCid++, l: eid, p: k, r: v, sup: false }); if (eid >= nextEid) nextEid = eid + 1; }
      }
      notify({ type: "load" });
    },
    // history(eid, attr) -> every value ever asserted, with its live flag — the FREE audit trail
    history(eid, attr) { return claims.filter((c) => c.l === eid && c.p === attr).map((c) => ({ value: c.r, live: !c.sup })); },
  };
}
