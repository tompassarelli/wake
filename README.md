# Wake

Wake compiles `.wake` declarations into one checked application graph and
projects it as direct-DOM JavaScript plus, for FRAM-backed applications, a FRAM
deployment plan. It is an application compiler, not a browser framework.

Wake owns application shape, validation, UI projection, and the closed
query/command and authorization seams. FRAM owns storage, history, occurrence
versions, and Datalog. A browser never speaks FRAMRPC or submits raw FRAM
queries; it uses only the operations in the checked Wake application.

## Install and verify

Wake's development commands run from `wake:web/`:

```sh
bun install --frozen-lockfile
./bin/wake-compile
bun run test
bun run test:browser
```

Supported tool versions are authoritative in
[`wake:web/package.json`](web/package.json). Compiler options are authoritative
in `./bin/wake-compile --help`. Published versions and release artifacts are on
[GitHub Releases](https://github.com/tompassarelli/wake/releases); runtime
package metadata is authoritative in
[`wake:web/runtime/package.json`](web/runtime/package.json).

## Compile an application

```sh
./bin/wake-compile --all demo/wiki.wake out/wiki
```

`(persist :localStorage "key")` selects browser-local authority.
`(backend :fram)` selects the FRAM gateway and deployment-plan path. They are
mutually exclusive.

FRAM-backed applications declare one identity field per entity, typed
references, named queries, and policy-checked commands. The runtime accepts the
official FRAM client surface and exact compiler-emitted artifacts. The host
supplies authentication, authorization, provider implementations, and any
server values; Wake does not expose those concerns as browser-controlled input.

The production Fetch/Cloudflare boundary and its public API are documented in
[`wake:web/runtime/README.md`](web/runtime/README.md). The canonical FRAM
example is [`wake:web/demo/wiki.wake`](web/demo/wiki.wake).

## Source authority

- `wake:web/compiler/` contains the Beagle/JS compiler sources.
- `wake:web/runtime/` contains the host-neutral runtime.
- `wake:web/plugins/` contains checked plugin packages.
- `wake:web/demo/` and `wake:web/tests/` contain executable examples and tests.

Generated files under `wake:web/out/` are artifacts. Change `.wake` or `.bjs`
sources and regenerate outputs instead of editing generated JavaScript.

## License

Wake is available under the MIT License or Apache License 2.0, at your option.
See [`wake:LICENSE`](LICENSE).
