# `@tompassarelli/wake-runtime`

The production Bun boundary for running one checked Wake application against
the official FRAM client. It contains the checked adapter and its internal HTTP,
gateway, named-query, receipt, and canonical-JSON implementation. It contains
no compiler, plugin implementation, dynamic plugin loader, or raw FRAM escape.

```js
import {
  createWakeBunAdapter,
  loadApplicationReceipt,
  rejectProviderInput,
} from "@tompassarelli/wake-runtime";

const applicationReceipt = await loadApplicationReceipt({
  applicationId: "my-application",
  deploymentReceipt,
  fram,
  manifest,
  plan,
});

const runtime = createWakeBunAdapter({
  applicationReceipt,
  authorize,
  browserClient,
  browserJavaScript,
  cursor: {
    activeKeyId: "current",
    keys: { current: cursorEncryptionKey },
  },
  deploymentReceipt,
  fram,
  manifest,
  plan,
  providers,
  schema,
});

const page = await runtime.executeQuery(
  "browse-articles",
  { status: "canonical" },
  { limit: 24 },
  { actor, traceId },
);

await runtime.invokeCommand(
  "publish-article",
  requestId,
  { articleId },
  { actor, traceId },
);
```

`loadApplicationReceipt` performs two bounded, application-scoped FRAM queries:
one to prove the receipt subject is unique and one snapshot-pinned document read.
It refuses a missing, duplicate, malformed, or artifact-mismatched durable
receipt. Receipt installation and migration are maintenance concerns and are
not part of this package.

Authentication remains host-owned. The adapter accepts only a derived actor
and trace ID, validates the checked artifact closure before composition, and
exposes HTTP plus direct named-query and command boundaries. The host
authorization decision supplies the mapped actor and, for paged queries, a
stable `authorizationScope`. Wake seals continuation state behind opaque,
application-bound cursors using the injected rotating AES-GCM key set.
`browserClient` and `browserJavaScript` must be the exact compiler-emitted
bytes bound by the deployment receipt. `providers` must exactly match
the provider bindings in the checked FRAM plan; extra, missing, accessor, or
non-function entries fail startup.

Checked providers can call `rejectProviderInput(message, detail?)` to return a
trusted, public `command/provider-rejected` error. Other thrown provider errors
are normalized to `command/provider-failed` without exposing their cause.
