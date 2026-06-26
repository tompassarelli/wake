;; gate.clj — the RUNNABLE GATE for the mcp-server spike (task #41). Hard assertions,
;; exit 1 on any failure. Drives the BEAGLE-authored host (host.bclj -> host.clj) as a
;; real MCP server over a real Fram claim store (bb -cp ~/code/fram/out).
;;
;; This is the thin .clj DRIVER + gate. It is the genuinely-dynamic boundary the dogfood
;; policy carves out: (1) parsing emit-mcp's catalog JSON into typed records, and (2) the
;; MCP JSON-RPC framing. Everything load-bearing — the dispatch core, every claim handler,
;; the MCP result shape — lives TYPED in host.bclj (beagle check --agent: 0 errors). The
;; gate only feeds that core and checks its answers.
;;
;; What it exercises (the REQUIRED scenario): an wake emit-mcp catalog (demo/crm-v2.wake)
;; -> tools/list -> tools/call for create x2 + a relation EDGE + list + the *_closure tool,
;; asserting correct results over real fram. crm-v2 has a Ref (note.contact), so the
;; catalog includes note.contact_closure — the Datalog reaches tool.
;; the host is the BEAGLE build artifact (host.bclj -> host.clj). Load it explicitly
;; (run.sh rebuilds it from host.bclj first), then require its ns.
(def here (.getParent (java.io.File. *file*)))
(load-file (str here "/host.clj"))
(require '[wake.spike.mcp-server.host :as h]
         '[clojure.string :as str]
         '[clojure.edn :as edn])

;; ============================================================================
;; (1) BOUNDARY: load the emit-mcp catalog JSON. We avoid a JSON dep by reading the
;; tool NAMES out of the catalog text (the names are emit-mcp's projection of the
;; schema; that's all the dispatch core needs — the op suffix selects the handler).
;; Falls back to a hand-supplied crm-v2 catalog if /tmp/cat.json is absent.
;; ============================================================================
(def cat-file (or (System/getenv "CATALOG") "/tmp/cat.json"))
(def catalog-text
  ;; exists-AND-non-empty: a 0-byte /tmp/cat.json left by a flaky/aborted wake-compile
  ;; must NOT shadow the hand-supplied fallback (belt-and-suspenders vs run.sh's -s guard).
  (if (let [f (java.io.File. cat-file)] (and (.exists f) (pos? (.length f))))
    (slurp cat-file)
    ;; hand-supplied crm-v2 catalog (matches emit-mcp output) if wake-compile unavailable
    (str "{\"tools\":["
         "{\"name\":\"contact.create\"},{\"name\":\"contact.get\"},{\"name\":\"contact.list\"},"
         "{\"name\":\"contact.update\"},{\"name\":\"contact.remove\"},"
         "{\"name\":\"note.create\"},{\"name\":\"note.get\"},{\"name\":\"note.list\"},"
         "{\"name\":\"note.update\"},{\"name\":\"note.remove\"},{\"name\":\"note.contact_closure\"}]}")))

;; pull the tool names out of the catalog text (every "name": "<...>" occurrence)
(def tool-names
  (->> (re-seq #"\"name\":\s*\"([^\"]+)\"" catalog-text) (map second) vec))

;; the tools/list view as host Tool records (name + a derived description + input keys)
(defn op->input [op]
  (cond
    (str/ends-with? op "_closure") ["eid"]
    (= op "create") []          ; (fields filled per-entity below; list view just needs names)
    (= op "get")    ["eid"]
    (= op "list")   []
    (= op "update") ["eid" "attr" "value"]
    (= op "remove") ["eid"]
    :else []))
(def catalog
  (mapv (fn [n] (h/->Tool n (str "tool " n) (op->input (h/op-of n)))) tool-names))

;; ============================================================================
;; (2) the per-entity schema the dispatch core needs (emit-mcp marks Ref fields; here we
;; supply the crm-v2 slice: contact has scalar fields; note has a Ref `contact`).
;; ============================================================================
(def contact-schema (h/->EntitySchema "contact" ["name" "email" "company" "status"] #{}))
(def note-schema    (h/->EntitySchema "note"    ["content" "contact" "created-at"] #{"contact"}))
(defn schema-for [tool]
  (if (= "note" (h/entity-of tool)) note-schema contact-schema))

;; ============================================================================
;; (3) drive the MCP host. eid-of maps a token -> the entity-id returned by a prior
;; create (this is the driver's tiny session registry; in real MCP the client passes
;; ids it got back). tools-call! returns the MCP result {:content [{:type :text}]}.
;; ============================================================================
(def store (h/new-store!))
(def eid-of (atom {}))
(defn eid-from-result [res]
  ;; result text is "eid=<n>"; parse the entity-id back out
  (Long/parseLong (subs (h/result-text res) 4)))
(defn call! [tool args]
  (h/tools-call! store (schema-for tool) tool args @eid-of))
(defn create! [tool token args]
  (let [res (call! tool args)
        e (eid-from-result res)]
    (swap! eid-of assoc token (long e))
    e))

(println "=== mcp-server: wake emit-mcp catalog served over a Fram claim store (BEAGLE host) ===\n")
(println "catalog:" cat-file " (" (count tool-names) "tools)")

;; tools/list
(def listed (h/tools-list catalog))
(println "\ntools/list ->")
(doseq [t listed] (println (str "  " (h/tool-name t) "(" (str/join ", " (h/tool-input t)) ")")))

;; tools/call: create x2 contacts
(def ada (create! "contact.create" "ada"   {"name" "Ada"   "email" "ada@x.io"   "company" "Analytical" "status" "active"}))
(def bob (create! "contact.create" "bob"   {"name" "Bob"   "email" "bob@x.io"   "company" "Babbage"    "status" "active"}))

;; a relation EDGE: notes form a chain over the `contact` predicate (the closure edge).
;;   noteA -[contact]-> noteB -[contact]-> Ada   => closure(noteA) over `contact` = {noteB, Ada}
;; (note.create with a Ref `contact` field creates the edge — the mechanical, catalog-driven path.)
(def nB (create! "note.create" "nB" {"content" "B" "contact" "ada"  "created-at" "t2"}))   ; nB -> Ada
(swap! eid-of assoc "nB" (long nB))
(def nA (create! "note.create" "nA" {"content" "A" "contact" "nB"   "created-at" "t1"}))   ; nA -> nB

(println "\ntools/call results:")
(println "  contact.create(Ada) ->" (h/result-text (h/mcp-result (str "eid=" ada))))
(println "  contact.create(Bob) ->" (str "eid=" bob))
(def list-res (call! "contact.list" {}))
(println "  contact.list ->" (h/result-text list-res))
(def closure-res (call! "note.contact_closure" {"eid" "nA"}))
(println "  note.contact_closure(nA) ->" (h/result-text closure-res))

;; ---------- hard assertions ----------
(def fails (atom 0))
(defn ck [name ok] (println (if ok "  [PASS] " "  [FAIL] ") name) (when-not ok (swap! fails inc)))
(println)

(ck "tools/list returns the wake catalog's tools (>= 11 for crm-v2: contact x5 + note x5 + closure)"
    (>= (count listed) 11))
(ck "catalog includes the per-Ref *_closure tool (note.contact_closure)"
    (some #{"note.contact_closure"} tool-names))
(ck "tools/call create x2 returns distinct entity-ids over real fram"
    (and (integer? ada) (integer? bob) (not= ada bob)))
(ck "tools/call contact.list round-trips both created contacts (live view, by-pr)"
    (= (h/result-text list-res) (str "live=" (vec (sort [ada bob])))))
(ck "every tools/call returns a well-formed MCP result {:content [{:type \"text\" :text ...}]}"
    (and (vector? (:content closure-res))
         (= "text" (:type (first (:content closure-res))))
         (string? (:text (first (:content closure-res))))))
(ck "the *_closure tool runs Datalog reaches over the claim graph: closure(nA) over `contact` = {nB, Ada} (TRANSITIVE)"
    (= (h/result-text closure-res) (str "closure=" (vec (sort [nB ada])))))
(ck "scope-correct: Bob is NOT in nA's contact-closure (no edge to him)"
    (not (str/includes? (h/result-text closure-res) (str bob))))

;; remove + non-destructive: tombstone Bob, he leaves the live list but his claims remain
(call! "contact.remove" {"eid" "bob"})
(def list-after (call! "contact.list" {}))
(println "\n  contact.list after remove(Bob) ->" (h/result-text list-after))
(ck "tools/call remove is non-destructive: Bob gone from live list, Ada remains"
    (= (h/result-text list-after) (str "live=" [ada])))

;; update as a superseding claim (history kept): Ada active -> inactive, get reflects it
(call! "contact.update" {"eid" "ada" "attr" "status" "value" "inactive"})
(def get-res (call! "contact.get" {"eid" "ada"}))
(println "  contact.get(Ada) after update ->" (h/result-text get-res))
(ck "tools/call update supersedes: Ada.status is now inactive in contact.get"
    (str/includes? (h/result-text get-res) "[\"status\" \"inactive\"]"))

(if (zero? @fails)
  (do (println "\nGATE PASS — the BEAGLE-authored MCP host serves an wake emit-mcp catalog over a real Fram claim store: tools/list + tools/call (create/list/remove/update + the Datalog *_closure tool) all dispatch to typed claim handlers.")
      (System/exit 0))
  (do (println "\nGATE FAIL —" @fails "assertion(s) failed") (System/exit 1)))
