(ns eddy.spike.mcp-server.host
  (:require [fram.cnf :as c]
            [fram.datalog :as d]
            [fram.types :as t]
            [clojure.string :as str]))

^{:line 31 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defrecord Store [ctx tx sup])

(defn store-ctx [r] (:ctx r))

(defn store-tx [r] (:tx r))

(defn store-sup [r] (:sup r))

^{:line 33 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defn ^Store new-store! []
  ^{:line 34 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (let [ctx ^{:line 34 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (c/new-store)
   tx ^{:line 34 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (c/begin-tx! ctx "mcp")
   sup ^{:line 34 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (c/value! ctx "mcp-supersedes")]
  ^{:line 37 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (c/set-supersedes-pred! ctx sup)
  ^{:line 38 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (->Store ctx tx sup)))

^{:line 42 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defn pid! [^Store s ^String name]
  ^{:line 42 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (c/value! ^{:line 42 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:ctx s) name))

^{:line 45 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defn pidr [^Store s ^String name]
  ^{:line 45 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (c/value-id ^{:line 45 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:ctx s) name))

^{:line 48 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defn field [^Store s e ^String p]
  ^{:line 49 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (let [pv ^{:line 49 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (pidr s p)
   cids ^{:line 49 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (if ^{:line 49 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (some? pv) ^{:line 49 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (c/by-lp ^{:line 49 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:ctx s) e pv) ^{:line 49 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} [])]
  ^{:line 51 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (if ^{:line 51 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (empty? cids) nil ^{:line 51 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (c/literal ^{:line 51 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:ctx s) ^{:line 51 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:r ^{:line 51 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (c/claim-of ^{:line 51 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:ctx s) ^{:line 51 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (first cids)))))))

^{:line 52 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defn ^Boolean tombstoned? [^Store s e]
  ^{:line 53 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (let [pv ^{:line 53 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (pidr s "mcp-tombstoned")]
  ^{:line 54 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (if ^{:line 54 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (some? pv) ^{:line 54 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (not ^{:line 54 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (empty? ^{:line 54 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (c/by-lp ^{:line 54 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:ctx s) e pv))) false)))

^{:line 62 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defn h-relate! [^Store s e ^String rel target]
  ^{:line 63 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (c/claim! ^{:line 63 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:ctx s) e ^{:line 63 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (pid! s rel) target ^{:line 63 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:tx s)))

^{:line 67 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defn h-update! [^Store s e ^String attr ^String value]
  ^{:line 68 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (let [pv ^{:line 68 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (pid! s attr)
   new-cid ^{:line 68 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (c/claim! ^{:line 68 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:ctx s) e pv ^{:line 68 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (c/value! ^{:line 68 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:ctx s) value) ^{:line 68 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:tx s))]
  ^{:line 70 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (doseq [old ^{:line 70 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (c/by-lp ^{:line 70 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:ctx s) e pv)]
  ^{:line 71 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (if ^{:line 71 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (not ^{:line 71 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (= old new-cid)) ^{:line 71 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (do
  ^{:line 72 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (c/claim! ^{:line 72 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:ctx s) new-cid ^{:line 72 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:sup s) old ^{:line 72 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:tx s)))))
  new-cid))

^{:line 77 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defn h-remove! [^Store s e]
  ^{:line 78 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (c/claim! ^{:line 78 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:ctx s) e ^{:line 78 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (pid! s "mcp-tombstoned") ^{:line 78 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (c/value! ^{:line 78 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:ctx s) "true") ^{:line 78 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:tx s)))

^{:line 81 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defn h-list [^Store s ^String kind]
  ^{:line 82 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (let [kp ^{:line 82 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (pidr s "mcp-kind")
   kv ^{:line 82 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (c/value-id ^{:line 82 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:ctx s) kind)
   cids ^{:line 82 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (if ^{:line 82 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (and ^{:line 82 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (some? kp) ^{:line 82 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (some? kv)) ^{:line 82 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (c/by-pr ^{:line 82 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:ctx s) kp kv) ^{:line 82 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} [])
   ents ^{:line 82 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (mapv ^{:line 82 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (fn [cid] ^{:line 82 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:l ^{:line 82 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (c/claim-of ^{:line 82 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:ctx s) cid))) cids)]
  ^{:line 86 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (filterv ^{:line 86 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (fn [e] ^{:line 86 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (not ^{:line 86 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (tombstoned? s e))) ents)))

^{:line 89 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defn h-get [^Store s e attrs]
  ^{:line 90 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (mapv ^{:line 90 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (fn [a] ^{:line 90 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} [a ^{:line 90 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (field s e a)]) attrs))

^{:line 97 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defn h-closure-with [^Store s e rp]
  ^{:line 98 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (let [db ^{:line 98 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (d/run-rules ^{:line 98 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:ctx s) ^{:line 98 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} [^{:line 98 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (d/rule "reaches" ^{:line 98 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} [^{:line 98 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (d/v :x) ^{:line 98 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (d/v :y)] ^{:line 98 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} [^{:line 98 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (d/lit "triple" ^{:line 98 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} [^{:line 98 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (d/v :x) rp ^{:line 98 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (d/v :y)])]) ^{:line 98 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (d/rule "reaches" ^{:line 98 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} [^{:line 98 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (d/v :x) ^{:line 98 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (d/v :z)] ^{:line 98 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} [^{:line 98 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (d/lit "triple" ^{:line 98 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} [^{:line 98 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (d/v :x) rp ^{:line 98 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (d/v :m)]) ^{:line 98 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (d/lit "reaches" ^{:line 98 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} [^{:line 98 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (d/v :m) ^{:line 98 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (d/v :z)])])])
   rows ^{:line 98 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (d/facts db "reaches")]
  ^{:line 105 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (into ^{:line 105 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} #{} ^{:line 106 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (mapv ^{:line 106 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (fn [row] ^{:line 106 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (first ^{:line 106 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (rest row))) ^{:line 107 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (filterv ^{:line 107 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (fn [row] ^{:line 107 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (= e ^{:line 107 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (first row))) rows)))))

^{:line 109 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defn h-closure [^Store s e ^String rel]
  ^{:line 110 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (let [rp ^{:line 110 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (pidr s rel)]
  ^{:line 111 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (if ^{:line 111 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (nil? rp) ^{:line 111 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} #{} ^{:line 112 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (h-closure-with s e rp))))

^{:line 122 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defn ^String op-of [^String tool-name]
  ^{:line 123 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (let [parts ^{:line 123 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (str/split tool-name #"\.")]
  ^{:line 123 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (last parts)))

^{:line 124 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defn ^String entity-of [^String tool-name]
  ^{:line 125 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (let [parts ^{:line 125 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (str/split tool-name #"\.")]
  ^{:line 125 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (first parts)))

^{:line 126 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defn ^Boolean closure-op? [^String op]
  ^{:line 126 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (str/ends-with? op "_closure"))

^{:line 127 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defn ^String rel-of [^String op]
  ^{:line 127 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (subs op 0 ^{:line 127 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (- ^{:line 127 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (count op) ^{:line 127 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (count "_closure"))))

^{:line 131 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defrecord EntitySchema [name fields refs])

(defn entityschema-name [r] (:name r))

(defn entityschema-fields [r] (:fields r))

(defn entityschema-refs [r] (:refs r))

^{:line 138 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defn h-create-with-refs! [^Store s ^String kind fields refs ent-of]
  ^{:line 140 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (let [e ^{:line 140 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (c/entity! ^{:line 140 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:ctx s))]
  ^{:line 141 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (c/claim! ^{:line 141 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:ctx s) e ^{:line 141 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (pid! s "mcp-kind") ^{:line 141 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (c/value! ^{:line 141 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:ctx s) kind) ^{:line 141 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:tx s))
  ^{:line 142 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (doseq [kv fields]
  ^{:line 143 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (let [k ^{:line 143 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (first kv)
   v ^{:line 143 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (first ^{:line 143 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (rest kv))]
  ^{:line 144 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (if ^{:line 144 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (contains? refs k) ^{:line 145 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (h-relate! s e k ^{:line 145 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (get ent-of v -1)) ^{:line 146 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (c/claim! ^{:line 146 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:ctx s) e ^{:line 146 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (pid! s k) ^{:line 146 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (c/value! ^{:line 146 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:ctx s) v) ^{:line 146 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:tx s)))))
  e))

^{:line 152 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defn ^String fmt-eid [e]
  ^{:line 152 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (str "eid=" e))

^{:line 153 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defn ^String fmt-list [es]
  ^{:line 153 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (str "live=" ^{:line 153 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (vec ^{:line 153 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (sort es))))

^{:line 154 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defn ^String fmt-get [pairs]
  ^{:line 154 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (str pairs))

^{:line 155 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defn ^String fmt-closure [es]
  ^{:line 155 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (str "closure=" ^{:line 155 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (vec ^{:line 155 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (sort ^{:line 155 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (vec es)))))

^{:line 165 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defn ^String arg [args ^String k]
  ^{:line 165 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (get args k ""))

^{:line 166 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defn eid-arg [args eid-of ^String k]
  ^{:line 167 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (get eid-of ^{:line 167 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (get args k "") -1))

^{:line 169 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defn ^String dispatch! [^Store s ^EntitySchema sch ^String tool args eid-of]
  ^{:line 171 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (let [op ^{:line 171 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (op-of tool)]
  ^{:line 172 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (cond
  ^{:line 173 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (closure-op? op) ^{:line 174 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (fmt-closure ^{:line 174 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (h-closure s ^{:line 174 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (eid-arg args eid-of "eid") ^{:line 174 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (rel-of op)))
  ^{:line 176 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (= op "create") ^{:line 177 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (let [fields ^{:line 177 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (mapv ^{:line 177 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (fn [f] ^{:line 177 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} [f ^{:line 177 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (arg args f)]) ^{:line 177 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:fields sch))]
  ^{:line 178 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (fmt-eid ^{:line 178 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (h-create-with-refs! s ^{:line 178 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:name sch) fields ^{:line 178 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:refs sch) eid-of)))
  ^{:line 180 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (= op "list") ^{:line 181 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (fmt-list ^{:line 181 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (h-list s ^{:line 181 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:name sch)))
  ^{:line 183 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (= op "get") ^{:line 184 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (fmt-get ^{:line 184 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (h-get s ^{:line 184 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (eid-arg args eid-of "eid") ^{:line 184 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:fields sch)))
  ^{:line 186 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (= op "update") ^{:line 187 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (fmt-eid ^{:line 187 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (h-update! s ^{:line 187 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (eid-arg args eid-of "eid") ^{:line 187 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (arg args "attr") ^{:line 187 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (arg args "value")))
  ^{:line 189 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (= op "remove") ^{:line 190 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (fmt-eid ^{:line 190 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (h-remove! s ^{:line 190 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (eid-arg args eid-of "eid")))
  :else ^{:line 192 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (str "ERROR: unknown op " op " in tool " tool))))

^{:line 200 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defrecord Tool [name desc input])

(defn tool-name [r] (:name r))

(defn tool-desc [r] (:desc r))

(defn tool-input [r] (:input r))

^{:line 204 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defn tools-list [catalog]
  catalog)

^{:line 207 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defn mcp-result [^String text]
  ^{:line 208 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} {:content ^{:line 208 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} [^{:line 208 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} {:type "text" :text text}]})

^{:line 211 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defn tools-call! [^Store s ^EntitySchema sch ^String tool args eid-of]
  ^{:line 213 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (mcp-result ^{:line 213 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (dispatch! s sch tool args eid-of)))

^{:line 216 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (defn result-text [res]
  ^{:line 217 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:text ^{:line 217 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (first ^{:line 217 :file "/home/tom/code/eddy/web/spike/mcp-server/host.bclj"} (:content res))))
