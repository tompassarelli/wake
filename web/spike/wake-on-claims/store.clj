;; wake-on-claims spike — gen-store's CRUD seam, backed by a Fram CLAIM store.
;;
;; The greenfield thesis (ADR 0001): an wake app's DATA should live as claims, not
;; SQL. This prototypes the claim-backed persistence runtime that would sit where
;; emit-sql/emit-server sit, mirroring the JS gen-store interface (add/update/remove/
;; all/load) but making EVERY operation a claim operation. bb renting fram/out — the
;; same altitude as the app-blast-radius spike (the claim layer, not the JS runtime).
;;
;; What it proves (falsifiable gate, exit 1 on any failure):
;;   1. CRUD works as claims: add -> entity!+claim!; update -> a SUPERSEDING claim.
;;   2. HISTORY IS FREE: after todo->doing->done, the prior values are STILL in the
;;      store (superseded, not destroyed). emit-sql's UPDATE clobbers them; you'd need
;;      a trigger + an audit table to recover what claims give intrinsically.
;;   3. REASONING IS FREE: "what is this task transitively waiting on?" is a 2-rule
;;      Datalog reaches-closure over depends_on edges — scope-correct (a same-named
;;      decoy on an unrelated entity is excluded). emit-sql needs a recursive CTE.
;;   4. DELETE IS NON-DESTRUCTIVE: remove tombstones; the entity leaves the live view
;;      but its facts remain for audit.
(require '[fram.cnf :as c] '[fram.datalog :as d] '[clojure.string :as str] '[clojure.edn :as edn])

(def ctx (c/new-store))
(def tx (c/begin-tx! ctx "todo"))

;; --- interning + a value-id->string reverse map (the store controls all writes) ---
(def pcache (volatile! {}))
(defn P [n] (or (get @pcache n) (let [v (c/value! ctx n)] (vswap! pcache assoc n v) v)))
(def vrev (volatile! {}))
(defn V [s] (let [id (c/value! ctx (str s))] (vswap! vrev assoc id (str s)) id))
(defn vstr [id] (get @vrev id))

(def KIND (P "kind"))
(def SUPS (P "supersedes"))
(c/set-supersedes-pred! ctx SUPS)
(def latest (volatile! {}))      ; [e attr] -> live claim id, for supersession on update
(def hist   (volatile! {}))      ; [e attr] -> [cid ...] in write order (audit enumeration)

;; ---- the store: gen-store's interface, every op a claim op -----------------------
(defn add! [kind fields]                                   ; gen-store.add(fields)
  (let [e (c/entity! ctx)]
    (c/claim! ctx e KIND (V kind) tx)
    (doseq [[a v] fields]
      (let [cid (c/claim! ctx e (P (name a)) (V v) tx)]
        (vswap! latest assoc [e (name a)] cid)
        (vswap! hist update [e (name a)] (fn [o] (conj (or o []) cid)))))
    e))

(defn update! [e attr v]                                   ; gen-store.update — supersede, keep history
  (let [old (get @latest [e attr])
        cid (c/claim! ctx e (P attr) (V v) tx)]
    (when old (c/claim! ctx cid SUPS old tx))              ; marks `old` not-live; cid = the superseder
    (vswap! latest assoc [e attr] cid)
    (vswap! hist update [e attr] (fn [o] (conj (or o []) cid)))
    cid))

(defn relate! [e pid target] (c/claim! ctx e pid target tx))  ; an edge: pid already interned, r is an entity id
(defn remove! [e] (c/claim! ctx e (P "tombstoned") (V "true") tx))  ; gen-store.remove — tombstone

(defn field [e attr]                                       ; live value of (e, attr)
  (let [cids (c/by-lp ctx e (P attr))] (when (seq cids) (vstr (:r (c/claim-of ctx (first cids)))))))
(defn tombstoned? [e] (seq (c/by-lp ctx e (P "tombstoned"))))
(defn all-tasks []                                         ; gen-store.all() — live, non-tombstoned
  (->> (c/by-pr ctx KIND (V "task")) (map #(:l (c/claim-of ctx %)))
       (remove tombstoned?) sort))
(defn history [e attr]                                     ; the FREE audit trail (live + superseded)
  (mapv (fn [cid] [(vstr (:r (c/claim-of ctx cid))) (if (c/live? ctx cid) "live" "superseded")])
        (get @hist [e attr])))

;; ---- a real greenfield todo session ----------------------------------------------
(def spec  (add! "task" {:title "write spec"  :status "todo"}))
(def build (add! "task" {:title "build"       :status "todo"}))
(def ship  (add! "task" {:title "ship"        :status "todo"}))
(def DEP (P "depends_on"))
(relate! build DEP spec)     ; build depends on spec
(relate! ship  DEP build)    ; ship depends on build   => ship transitively waits on {build, spec}
;; a scope-correctness decoy: an unrelated note entity whose title leaf is also "spec"
(def note (add! "note" {:title "spec"}))
;; edits: progress the spec task todo -> doing -> done (two superseding updates)
(update! spec "status" "doing")
(update! spec "status" "done")
;; a throwaway, then remove it (tombstone)
(def junk (add! "task" {:title "scratch" :status "todo"}))
(remove! junk)

;; ---- REASONING FOR FREE: transitive depends_on closure (2 Datalog rules) ----------
(def db (d/run-rules ctx
  [(d/rule "waits" [(d/v :t) (d/v :d)] [(d/lit "triple" [(d/v :t) DEP (d/v :d)])])
   (d/rule "waits" [(d/v :t) (d/v :d)] [(d/lit "triple" [(d/v :t) DEP (d/v :m)])
                                        (d/lit "waits"  [(d/v :m) (d/v :d)])])]))
(def ship-waits (->> (d/facts db "waits") (filter #(= ship (first %))) (map second) set))

;; ---- gate -------------------------------------------------------------------------
(defn title-of [e] (field e "title"))
(println "=== wake-on-claims: the todo app's data as Fram claims (no SQL) ===\n")
(println "live tasks (all()):        " (mapv title-of (all-tasks)))
(println "spec.status (live):        " (field spec "status"))
(println "spec.status HISTORY:       " (history spec "status") "  <- emit-sql UPDATE would keep only [done]")
(println "ship transitively waits on:" (sort (map title-of ship-waits))
         "  <- emit-sql needs a recursive CTE")
(println)
(def checks
  [["CRUD: 3 live tasks (junk tombstoned, note is a different kind)" (= (set (map title-of (all-tasks))) #{"write spec" "build" "ship"})]
   ["update is a superseding claim: spec.status is now 'done'"        (= (field spec "status") "done")]
   ["HISTORY FREE: todo+doing superseded but STILL in the store"      (= (history spec "status") [["todo" "superseded"] ["doing" "superseded"] ["done" "live"]])]
   ["REASONING FREE: ship transitively waits on {build, write spec}"  (= (set (map title-of ship-waits)) #{"build" "write spec"})]
   ["SCOPE-CORRECT: the note titled 'spec' is NOT in ship's waits"    (not (contains? ship-waits note))]
   ["DELETE non-destructive: junk gone from all(), claims remain"     (and (not (some #{junk} (all-tasks))) (seq (c/by-lp ctx junk (P "title"))))]])
(doseq [[nm ok] checks] (println (if ok "  [PASS] " "  [FAIL] ") nm))
(println "\n--- ceremony contrast (what emit-sql/emit-server would require) ---")
(println "  schema:   CREATE TABLE task(...) + ALTER on every new field   ->  claims: none (predicates are open)")
(println "  history:  a trigger + a task_audit table to not lose updates  ->  claims: intrinsic (supersession)")
(println "  transit:  WITH RECURSIVE cte AS (...) ...                      ->  claims: 2 Datalog rules above")
;; ---- DURABILITY: persist (dump) -> reload into a FRESH store -> data, history, and
;;      reasoning all survive. This is what (persist :localStorage) needs — but claims
;;      give it as a real backend that ALSO retains history across the reload boundary. ----
(def dump-file "/tmp/wake-todo.claims-dump.edn")
(spit dump-file (pr-str (c/dump-store ctx)))                 ; the "save" (localStorage/SQL analog)
(def dumpv (edn/read-string (slurp dump-file)))
(def ctx2 (c/new-store))
(c/load-store! ctx2 dumpv)                                   ; the "load" into a brand-new process/store
;; re-query the RELOADED store from scratch (entity + value ids are preserved across dump/load);
;; use c/literal — the proper inverse of value! (no in-process reverse map needed).
(def K2 (c/value-id ctx2 "kind")) (def TI2 (c/value-id ctx2 "title"))
(def ST2 (c/value-id ctx2 "status")) (def DEP2 (c/value-id ctx2 "depends_on")) (def TB2 (c/value-id ctx2 "tombstoned"))
(defn lit2 [e pid] (let [cs (c/by-lp ctx2 e pid)] (when (seq cs) (c/literal ctx2 (:r (c/claim-of ctx2 (first cs)))))))
(def tasks2 (->> (c/by-pr ctx2 K2 (c/value-id ctx2 "task")) (map #(:l (c/claim-of ctx2 %)))
                 (remove #(seq (c/by-lp ctx2 % TB2))) set))
(def db2 (d/run-rules ctx2
  [(d/rule "waits" [(d/v :t) (d/v :d)] [(d/lit "triple" [(d/v :t) DEP2 (d/v :d)])])
   (d/rule "waits" [(d/v :t) (d/v :d)] [(d/lit "triple" [(d/v :t) DEP2 (d/v :m)]) (d/lit "waits" [(d/v :m) (d/v :d)])])]))
(def ship-waits2 (->> (d/facts db2 "waits") (filter #(= ship (first %))) (map second) set))
(def spec-status-persisted (->> (:claims dumpv) (filter (fn [kv] (and (= (:l (second kv)) spec) (= (:p (second kv)) ST2)))) count))
(println "\n--- durability: persisted to" dump-file ", reloaded into a fresh store ---")
(println "  reloaded live tasks:        " (sort (map #(lit2 % TI2) tasks2)))
(println "  reloaded spec.status:       " (lit2 spec ST2))
(println "  reloaded ship waits on:     " (sort (map #(lit2 % TI2) ship-waits2)))
(println "  spec status claims in dump: " spec-status-persisted "(live: 1) <- history persisted through serialization")
(def reload-checks
  [["DURABLE: live tasks survive persist->reload"            (= (set (map #(lit2 % TI2) tasks2)) #{"write spec" "build" "ship"})]
   ["DURABLE: spec.status='done' survives reload"            (= (lit2 spec ST2) "done")]
   ["DURABLE: transitive reasoning survives reload"          (= (set (map #(lit2 % TI2) ship-waits2)) #{"build" "write spec"})]
   ["DURABLE: history (todo/doing/done) persisted in dump"   (>= spec-status-persisted 3)]])
(doseq [[nm ok] reload-checks] (println (if ok "  [PASS] " "  [FAIL] ") nm))
(if (every? second (concat checks reload-checks))
  (do (println "\nGATE PASS — an wake app's data lives as claims: CRUD + history + scope-correct reasoning,")
      (println "            durable across persist/reload. All free; no SQL, no schema, no migrations.") (System/exit 0))
  (do (println "\nGATE FAIL — wake-on-claims does not hold on this fixture.") (System/exit 1)))
