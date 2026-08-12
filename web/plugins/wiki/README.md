# wake-wiki

`wake-wiki` is Wake's first-party revisioned-document plugin. Its source is
ordinary Beagle and is consumed at compile time; it is not a runtime plugin
loader, storage adapter, authentication policy, or content parser.

The 0.1 contract provides:

- stable resources with immutable revisions and draft/published pointers;
- atomic draft, replacement, abandonment, and publication commands;
- bounded published, draft, history, and backlink queries;
- explicit capabilities, extension ports, provider bindings, and route mounts;
- a closed, bounded `SafeDocument` value produced by a host content provider.

The application owns storage authority, actor identity, policy grants, concrete
routes, content-provider implementation, and product-specific limits. Importing
the plugin grants nothing and mounts nothing.

`plugin.bjs` is the authored Beagle entry. `wake-plugin.json` is the package
envelope. Storage identity is explicit and never derived from aliases, labels,
versions, hostnames, or route paths.

The provider/client value contract is frozen in
`wake:web/plugins/wiki/SAFE-DOCUMENT.md`. From this package directory, run:

```sh
bun test
```
