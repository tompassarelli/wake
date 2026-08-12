# Wake

Wake is a Beagle library and domain compiler for web applications. Applications
are ordinary `.bjs` modules: Beagle owns their syntax, types, imports, macros,
source locations, and checking. Wake validates the checked application model
and projects it into deployable artifacts.

```clojure
#lang beagle/js
(ns example.app
  (:require [wake.core :as wake]))
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

[`web/wake/core.bjs`](web/wake/core.bjs) defines Wake's public Beagle forms and
types. Generated JavaScript, plans, manifests, and receipts are artifacts.
Change Beagle source and regenerate them.

## License

Wake is available under the MIT License or Apache License 2.0, at your option.
See [`LICENSE`](LICENSE).
