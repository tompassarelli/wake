;; serve.clj — the BONUS thin MCP JSON-RPC stdin/stdout loop (task #41 #3, "a bonus").
;;
;; This is the GAP-LISTED dynamic boundary: line-delimited JSON-RPC framing + JSON
;; parsing of the wire. Kept minimal and in .clj on purpose — the typed, load-bearing
;; core (dispatch + every claim handler + the MCP result shape) lives in host.bclj
;; (beagle check --agent: 0 errors) and is reused unchanged here. This file only does
;; the I/O envelope around that core, which is the part Beagle can't express (no stdin
;; reader / no JSON codec / no JSON-RPC notion in the typed surface — a real gap).
;;
;; Protocol served (a minimal subset of MCP over JSON-RPC 2.0, newline-delimited):
;;   initialize           -> server capabilities
;;   tools/list           -> the eddy emit-mcp catalog's tools
;;   tools/call {name,arguments} -> dispatch to the claim handler, MCP result content
;;
;; Run:    bb -cp ~/code/fram/out spike/mcp-server/serve.clj   (reads requests on stdin)
;; Smoke:  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | bb -cp ~/code/fram/out serve.clj
(def here (.getParent (java.io.File. (.getCanonicalPath (java.io.File. *file*)))))
(load-file (str here "/host.clj"))
(require '[eddy.spike.mcp-server.host :as h]
         '[cheshire.core :as json]
         '[clojure.string :as str]
         '[clojure.java.io :as io])

;; ---- catalog (same source as the gate): tool names out of the emit-mcp JSON ----
(def cat-file (or (System/getenv "CATALOG") "/tmp/cat.json"))
(def catalog-json
  (if (.exists (java.io.File. cat-file))
    (json/parse-string (slurp cat-file) true)
    {:tools [{:name "contact.create"} {:name "contact.get"} {:name "contact.list"}
             {:name "contact.update"} {:name "contact.remove"}
             {:name "note.create"} {:name "note.get"} {:name "note.list"}
             {:name "note.update"} {:name "note.remove"} {:name "note.contact_closure"}]}))
(def tool-names (mapv :name (:tools catalog-json)))

;; per-entity schema slice (crm-v2): note.contact is the Ref edge field
(def contact-schema (h/->EntitySchema "contact" ["name" "email" "company" "status"] #{}))
(def note-schema    (h/->EntitySchema "note"    ["content" "contact" "created-at"] #{"contact"}))
(defn schema-for [tool] (if (= "note" (h/entity-of tool)) note-schema contact-schema))

;; ---- the live store + a token->eid registry (clients pass back eids they received) ----
(def store (h/new-store!))
(def eid-of (atom {}))

(defn tools-list-payload []
  ;; tools/list: project the catalog into MCP tool descriptors (name + inputSchema)
  (mapv (fn [n] {:name n :description (str "tool " n)
                 :inputSchema {:type "object"}}) tool-names))

(defn handle-call [params]
  (let [tool (:name params)
        args (into {} (map (fn [[k v]] [(name k) (str v)]) (:arguments params)))
        res  (h/tools-call! store (schema-for tool) tool args @eid-of)
        text (h/result-text res)]
    ;; if a create returned an eid, register it under the entity name + the eid itself
    (when (str/starts-with? text "eid=")
      (let [e (Long/parseLong (subs text 4))]
        (swap! eid-of assoc (str e) e)))
    res))

(defn handle [req]
  (let [m (:method req) id (:id req)]
    (cond
      (= m "initialize")
      {:jsonrpc "2.0" :id id
       :result {:protocolVersion "2024-11-05"
                :capabilities {:tools {}}
                :serverInfo {:name "eddy-mcp-claim-host" :version "0.1"}}}
      (= m "tools/list")
      {:jsonrpc "2.0" :id id :result {:tools (tools-list-payload)}}
      (= m "tools/call")
      {:jsonrpc "2.0" :id id :result (handle-call (:params req))}
      :else
      {:jsonrpc "2.0" :id id :error {:code -32601 :message (str "method not found: " m)}})))

;; ---- the loop: one JSON-RPC request per line of stdin; one JSON response per line ----
(with-open [rdr (io/reader *in*)]
  (doseq [line (line-seq rdr)]
    (when-not (str/blank? line)
      (let [req (json/parse-string line true)
            resp (handle req)]
        (println (json/generate-string resp))
        (flush)))))
