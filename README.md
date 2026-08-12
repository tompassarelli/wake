# Wake

Wake is a Beagle library and domain compiler for web applications. Applications
are ordinary `.bjs` modules: Beagle owns their syntax, types, imports, macros,
source locations, and checking. Wake validates the checked application model
and projects it to direct-DOM JavaScript and, when selected, a FRAM plan.

```clojure
#lang beagle/js
(ns example.app
  (:require [wake.core :as wake]))

(wake/application application "example")
(wake/backend backend :fram)

(wake/defentity note Note
  [id: String
   body: String]
  :id
  {:body :create}
  [])
```

Wake is not a browser framework or a storage engine. It owns application-domain
validation and projection; FRAM owns storage and query execution, while the host
owns authentication, authorization, and provider implementations.

## Build and test

Run development commands from `web/`:

```sh
bun install --frozen-lockfile
./bin/wake-compile --all path/to/application.bjs out/application
bun run test
```

## Source authority

- [`web/wake/core.bjs`](web/wake/core.bjs) defines Wake's public Beagle forms and
  types.
- [`web/bin/wake-compile`](web/bin/wake-compile) defines compiler invocation and
  output selection.
- [`web/package.json`](web/package.json) defines supported development commands
  and tool versions.
- [`web/runtime/README.md`](web/runtime/README.md) defines the production runtime
  boundary.

Generated JavaScript, plans, manifests, and receipts are artifacts. Change the
authoritative Beagle or Wake source and regenerate them.

## License

Wake is available under the MIT License or Apache License 2.0, at your option.
See [`LICENSE`](LICENSE).
