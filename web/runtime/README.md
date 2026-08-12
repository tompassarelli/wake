# `@tompassarelli/wake-runtime`

The production Fetch boundary for running one checked Wake application against
the official FRAM client. It contains the checked adapter, a Cloudflare Worker
host, and the internal HTTP, gateway, named-query, receipt, and canonical-JSON
implementation. It contains no compiler, plugin implementation, dynamic plugin
loader, or raw FRAM escape.

```js
import {
  createWakeApplicationAdapter,
  createWakeWorkerHost,
  installApplication,
  loadApplicationReceipt,
  rejectProviderInput,
} from "@tompassarelli/wake-runtime";

const applicationReceipt = await installApplication({
  applicationId: "my-application",
  deploymentReceipt,
  fram,
  manifest,
  plan,
  schema,
  async initialize({ applicationReceipt, plan, schema }) {
    await reconcileApplicationPrincipals({ applicationReceipt, plan, schema });
  },
});

await loadApplicationReceipt({
  applicationId: "my-application",
  deploymentReceipt,
  fram,
  manifest,
  plan,
}); // Verifies the ready receipt without changing state.

const runtime = createWakeApplicationAdapter({
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
  serverValues,
});

const worker = createWakeWorkerHost({
  route(request) {
    return new URL(request.url).pathname === "/api/application";
  },
  async handle(request, env, ctx) {
    // Verify host credentials and dispatch the application's closed API here.
    return applicationApi.fetch(request, { env, ctx, runtime });
  },
  fallback(request, env) {
    return env.ASSETS.fetch(request);
  },
});

export default worker;

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
receipt. `installApplication` is the maintenance boundary: it validates the
artifact closure before writes, records a durable installing intent and
compiled schema, awaits an idempotent initializer, atomically advances the
exact intent to ready, and then re-verifies the receipt. Failed initialization
leaves a resumable intent that `loadApplicationReceipt` will not accept.

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
`serverValues` is an optional static data registry whose own enumerable keys
must exactly match checked server-value injections; Wake type-checks and
freezes every value during startup and never invokes it as a callback.

`createWakeWorkerHost` has the standard module Worker `fetch(request, env,
ctx)` signature. The application supplies a synchronous `route` predicate and
a closed `handle` boundary, so its public URL and protocol remain an application
concern; Wake never forces the raw `/api/wake` protocol onto the internet.
`fallback` can delegate every other route to a Cloudflare static-assets binding.
The Worker host imports no Cloudflare module, does not inspect credentials, and
does not select a FRAM transport. Applications inject the official FRAM client
backed by either native FRAMRPC or a Durable Object transport.

`fallback` is not authenticated by Wake. Use it only for deliberately public
assets. A protected application should select every request in `route`, verify
the request in `handle`, and call its Assets binding only after authentication
and origin checks. The optional `onError` receives the caught error plus only
the closed phase and execution context; it does not receive request headers or
environment bindings. It must return a sanitized `Response` and must not expose
or indiscriminately log error contents.

Checked providers can call `rejectProviderInput(message, detail?)` to return a
trusted, public `command/provider-rejected` error. Other thrown provider errors
are normalized to `command/provider-failed` without exposing their cause.

`compileCheckedValue` and `normalizeCheckedValue` validate and freeze values
against Wake's bounded recursive value descriptors. `renderSafeDocument`
accepts only a descriptor-checked SafeDocument, constructs DOM nodes without
HTML string sinks, and resolves its closed SafeUrl union through a caller-owned
navigation policy.
