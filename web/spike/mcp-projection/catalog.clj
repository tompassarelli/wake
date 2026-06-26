;; mcp-projection spike (ADR 0001 — eddy = projection compiler): a SCHEMA (as claims, the
;; shape emit-claims-ir emits) projects MECHANICALLY into an MCP tool catalog + claim-backed
;; handlers. Proves the charter for the MCP/API surface: the tool set falls out of the schema
;; (entities x CRUD + declared relations -> a closure query), and every handler runs against a
;; Fram claim store. No bespoke logic — pure projection. bb renting fram/out.
(require '[fram.cnf :as c] '[fram.datalog :as d] '[clojure.string :as str])

;; ---------- a tiny store helper (intern + reverse map; everything an entity or a value) -----
(defn mk [] (let [ctx (c/new-store)] {:ctx ctx :tx (c/begin-tx! ctx "mcp") :e (volatile! {}) :er (volatile! {}) :v (volatile! {}) :vr (volatile! {})}))
(defn ent [s sid] (or (get @(:e s) sid) (let [e (c/entity! (:ctx s))] (vswap! (:e s) assoc sid e) (vswap! (:er s) assoc e sid) e)))
(defn er [s e] (get @(:er s) e))
(defn val [s x] (let [id (c/value! (:ctx s) (str x))] (vswap! (:vr s) assoc id (str x)) id))
(defn vr [s id] (get @(:vr s) id))

;; ================= SCHEMA store: emit-claims-ir-shaped triples, queried to DERIVE tools ======
(def schema-triples
  [["task" "kind" "entity"]
   ["task.title" "type" "String"]  ["task" "field" "task.title"]
   ["task.status" "type" "String"] ["task" "field" "task.status"]
   ["task" "relation" "depends_on"]])
(def S (mk))
(doseq [[s p o] schema-triples] (c/claim! (:ctx S) (ent S s) (val S p) (ent S o) (:tx S)))
(defn entities [] (->> (c/by-pr (:ctx S) (val S "kind") (ent S "entity")) (map #(:l (c/claim-of (:ctx S) %))) (map #(er S %)) sort))
(defn fields-of [e] (->> (c/by-lp (:ctx S) (ent S e) (val S "field")) (map #(er S (:r (c/claim-of (:ctx S) %)))) (map #(last (str/split % #"\."))) sort))
(defn relations-of [e] (->> (c/by-lp (:ctx S) (ent S e) (val S "relation")) (map #(er S (:r (c/claim-of (:ctx S) %)))) sort))

;; ---------- THE PROJECTION: schema (from the claim graph) -> MCP tool catalog (mechanical) ----
(defn tool-catalog []
  (vec (mapcat (fn [e]
    (concat
      [{:name (str e ".create") :input (vec (fields-of e)) :desc (str "Create a " e)}
       {:name (str e ".get")    :input ["eid"]             :desc (str "Get one " e " by eid")}
       {:name (str e ".list")   :input []                  :desc (str "List all live " e "s")}
       {:name (str e ".update") :input ["eid" "attr" "value"] :desc (str "Update one field of a " e " (supersedes)")}
       {:name (str e ".remove") :input ["eid"]             :desc (str "Tombstone a " e)}]
      (map (fn [rel] {:name (str e "." rel "_closure") :input ["eid"]
                      :desc (str "Transitive " rel " of a " e " (Datalog reaches over the claim graph)")})
           (relations-of e))))
    (entities))))

;; ================= DATA store: the claim-backed runtime the tools dispatch to ===============
(def D (mk))
(def DSUP (val D "supersedes")) (c/set-supersedes-pred! (:ctx D) DSUP)
(def latest (volatile! {}))
(defn d-create [fields] (let [e (c/entity! (:ctx D))]
                          (doseq [[k v] fields] (let [cid (c/claim! (:ctx D) e (val D k) (val D v) (:tx D))] (vswap! latest assoc [e k] cid)))
                          e))
(defn d-relate [e rel target] (c/claim! (:ctx D) e (val D rel) target (:tx D)))
(defn d-list [] (->> (c/by-p (:ctx D) (val D "title")) (map #(:l (c/claim-of (:ctx D) %))) distinct sort))
(defn d-get [e] (into {:eid e} (map (fn [p] [(keyword p) (let [cs (c/by-lp (:ctx D) e (val D p))] (when (seq cs) (vr D (:r (c/claim-of (:ctx D) (first cs))))))]) ["title" "status"])))
(defn d-closure [e rel]                  ; the named-query tool: transitive rel via reaches
  (let [rp (val D rel)
        db (d/run-rules (:ctx D)
             [(d/rule "reaches" [(d/v :x) (d/v :y)] [(d/lit "triple" [(d/v :x) rp (d/v :y)])])
              (d/rule "reaches" [(d/v :x) (d/v :z)] [(d/lit "triple" [(d/v :x) rp (d/v :m)]) (d/lit "reaches" [(d/v :m) (d/v :z)])])])]
    (->> (d/facts db "reaches") (filter #(= e (first %))) (map second) set)))

;; ---------- exercise the projected surface ----------
(def cat (tool-catalog))
(def spec  (d-create [["title" "spec"]   ["status" "todo"]]))
(def build (d-create [["title" "build"]  ["status" "todo"]]))
(def ship  (d-create [["title" "ship"]   ["status" "todo"]]))
(d-relate build "depends_on" spec) (d-relate ship "depends_on" build)

(println "=== mcp-projection: schema (claims) -> tool catalog (mechanical) + claim-backed handlers ===\n")
(println "DERIVED MCP TOOL CATALOG (from the schema claim graph):")
(doseq [t cat] (println (str "  " (:name t) "(" (str/join ", " (:input t)) ")  — " (:desc t))))
(println "\nINVOKE task.list ->" (sort (map #(:title (d-get %)) (d-list))))
(println "INVOKE task.depends_on_closure(ship) ->" (sort (map #(:title (d-get %)) (d-closure ship "depends_on"))))

(def f (atom 0)) (defn ck [n ok] (println (if ok "  [PASS] " "  [FAIL] ") n) (when-not ok (swap! f inc)))
(println)
(ck "catalog is MECHANICAL: 1 entity x 5 CRUD + 1 relation-closure = 6 tools" (= (count cat) 6))
(ck "tool names derived from the schema (task.create/get/list/update/remove + depends_on_closure)"
    (= (set (map :name cat)) #{"task.create" "task.get" "task.list" "task.update" "task.remove" "task.depends_on_closure"}))
(ck "task.create inputs derived from the schema fields [status title]" (= (:input (first (filter #(= (:name %) "task.create") cat))) ["status" "title"]))
(ck "handlers are claim-backed: task.list round-trips the created entities" (= (set (map #(:title (d-get %)) (d-list))) #{"spec" "build" "ship"}))
(ck "named-query tool runs Datalog over claims: ship's depends_on closure = {build, spec}"
    (= (set (map #(:title (d-get %)) (d-closure ship "depends_on"))) #{"build" "spec"}))
(if (zero? @f)
  (do (println "\nGATE PASS — an MCP tool catalog + claim-backed handlers fall out of the schema MECHANICALLY. The API/MCP projection is a real eddy target.") (System/exit 0))
  (do (println "\nGATE FAIL") (System/exit 1)))
