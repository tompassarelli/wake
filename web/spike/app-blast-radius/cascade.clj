;; App-level blast-radius scope-correctness gate (wake x Beagle unified plan, move 1).
;; Loads wake's app-claim graph into a Fram store and derives the blast radius of a
;; field change via a transitive reaches-closure over `dep` edges. Asserts the result
;; is SCOPE-CORRECT: it includes the genuine dependent and EXCLUDES a same-leaf-named
;; decoy on an unrelated entity (which a bare-name/regex pass wrongly drags in).
;; Mirrors Beagle's mod_a/mod_b cascade receipt, one altitude up (app, not code).
;; Exit 0 = scope-correct; exit 1 = corruption (gate fails the build).
(require '[clojure.edn :as edn] '[clojure.string :as str]
         '[fram.cnf :as c] '[fram.datalog :as d])
(def claims-path (or (System/getenv "CLAIMS") "/tmp/crm-v2-spike.claims"))
(def triples (->> (slurp claims-path) str/split-lines
                  (filter #(str/starts-with? % "[")) (mapv edn/read-string)))
(def ctx (c/new-store)) (def tx (c/begin-tx! ctx "spike"))
(def s->id (volatile! {})) (def id->s (volatile! {}))
(defn ent [s] (or (get @s->id s)
                  (let [e (c/entity! ctx)] (vswap! s->id assoc s e) (vswap! id->s assoc e s) e)))
(def vc (volatile! {}))
(defn val [v] (or (get @vc v) (let [x (c/value! ctx (str v))] (vswap! vc assoc v x) x)))
(doseq [[s p o] triples] (c/claim! ctx (ent s) (val p) (ent (str o)) tx))
(def DEP (val "dep"))
(def CHANGE (ent "contact.company"))
(def db (d/run-rules ctx
  [(d/rule "affected" [(d/v :d)] [(d/lit "triple" [(d/v :d) DEP CHANGE])])
   (d/rule "affected" [(d/v :d)] [(d/lit "triple" [(d/v :d) DEP (d/v :m)])
                                  (d/lit "affected" [(d/v :m)])])]))
(def graph-aff (->> (d/facts db "affected") (map first) (map #(get @id->s %)) set))
(def naive (->> triples (map first) distinct
                (filter #(and (str/includes? % ".")
                              (= "company" (last (str/split % #"\.")))))
                set))
(println "QUERY: change contact.company — what is the blast radius?\n")
(println "  NAIVE (bare leaf-name \"company\"):        " (sort naive))
(println "  GRAPH (reaches-closure over dep edges):  " (sort graph-aff) "\n")
(def gate-ok
  (and (contains? naive "note.company")               ; naive corrupts (the contrast)
       (not (contains? graph-aff "note.company"))      ; graph excludes the decoy
       (contains? graph-aff "contact.display-name")))  ; graph includes the real dependent
(if gate-ok
  (do (println "GATE PASS — decoy note.company absent from graph; real contact.display-name present;"
               "\n           naive drags the decoy in. App-as-claims blast radius is scope-correct.")
      (System/exit 0))
  (do (println "GATE FAIL — scope-correctness violated (kill-criterion #1).") (System/exit 1)))
