export class WakeWorkerConfigError extends TypeError {
  constructor(message) {
    super(message);
    this.name = "WakeWorkerConfigError";
  }
}

function config(condition, message) {
  if (!condition) throw new WakeWorkerConfigError(message);
}

function checkedResponse(value, label) {
  if (!(value instanceof Response)) {
    throw new WakeWorkerConfigError(`${label} must return a Response`);
  }
  return value;
}

function internalError() {
  return new Response(JSON.stringify({
    error: {
      code: "worker/internal-error",
      message: "The Wake Worker request failed.",
    },
  }), {
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
    },
    status: 500,
  });
}

/**
 * Creates a Cloudflare module-Worker-compatible Fetch host around an
 * application-owned closed request boundary. Wake supplies the host mechanics;
 * the application owns its public routes, authentication, policy, and mapping
 * onto the injected checked Wake adapter.
 */
export function createWakeWorkerHost({
  fallback,
  handle,
  onError,
  route,
} = {}) {
  config(typeof route === "function", "route must be a function");
  config(typeof handle === "function", "handle must be a function");
  config(fallback === undefined || typeof fallback === "function",
    "fallback must be a function");
  config(onError === undefined || typeof onError === "function", "onError must be a function");

  async function recover(error, executionContext, phase) {
    if (onError === undefined) return internalError();
    try {
      return checkedResponse(await onError(error, Object.freeze({
        executionContext,
        phase,
      })), "onError");
    } catch {
      return internalError();
    }
  }

  async function fetch(request, environment, executionContext) {
    if (!(request instanceof Request)) {
      return recover(
        new WakeWorkerConfigError("fetch requires a Request"),
        executionContext,
        "request",
      );
    }

    let selected;
    try {
      selected = route(request, environment, executionContext);
      config(typeof selected === "boolean", "route must return a boolean");
    } catch (error) {
      return recover(error, executionContext, "route");
    }

    if (!selected) {
      if (fallback === undefined) return new Response(null, { status: 404 });
      try {
        return checkedResponse(
          await fallback(request, environment, executionContext),
          "fallback",
        );
      } catch (error) {
        return recover(error, executionContext, "fallback");
      }
    }

    try {
      return checkedResponse(
        await handle(request, environment, executionContext),
        "handle",
      );
    } catch (error) {
      return recover(error, executionContext, "handle");
    }
  }

  return Object.freeze({ fetch });
}
