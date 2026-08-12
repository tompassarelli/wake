import { expect, test } from "bun:test";

import {
  createWakeWorkerHost,
  WakeWorkerConfigError,
} from "./worker-host.mjs";

function fixture(overrides = {}) {
  const calls = { fallback: [], handle: [], route: [] };
  const route = (request, environment, executionContext) => {
    calls.route.push({ environment, executionContext, request });
    return new URL(request.url).pathname === "/api/wiki";
  };
  const handle = async (request, environment, executionContext) => {
    calls.handle.push({ environment, executionContext, request });
    return Response.json({ principal: environment.principal });
  };
  const fallback = async (request, environment, executionContext) => {
    calls.fallback.push({ environment, executionContext, request });
    return new Response(`asset:${new URL(request.url).pathname}`);
  };
  return { calls, fallback, handle, route, ...overrides };
}

test("hosts an application-owned closed route on the module Worker Fetch signature", async () => {
  const input = fixture();
  const host = createWakeWorkerHost(input);
  const environment = { principal: "editor-1" };
  const executionContext = { waitUntil() {} };
  const request = new Request("https://wiki.example/api/wiki", {
    body: JSON.stringify({ op: "article.browse" }),
    method: "POST",
  });

  expect(Object.isFrozen(host)).toBe(true);
  const response = await host.fetch(request, environment, executionContext);
  expect(await response.json()).toEqual({ principal: "editor-1" });
  expect(input.calls.route).toEqual([{ environment, executionContext, request }]);
  expect(input.calls.handle).toEqual([{ environment, executionContext, request }]);
  expect(input.calls.fallback).toEqual([]);
});

test("does not prescribe or expose Wake's raw operation protocol", async () => {
  const input = fixture();
  const host = createWakeWorkerHost(input);
  const environment = { principal: "editor-1" };
  const executionContext = { waitUntil() {} };

  for (const path of ["/api/wake", "/api/wake/query", "/articles/ashen-stair"]) {
    const request = new Request(`https://wiki.example${path}`);
    const response = await host.fetch(request, environment, executionContext);
    expect(await response.text()).toBe(`asset:${path}`);
  }

  expect(input.calls.handle).toEqual([]);
  expect(input.calls.fallback).toHaveLength(3);
});

test("supports a route predicate over environment bindings", async () => {
  const input = fixture({
    route(request, environment) {
      input.calls.route.push({ environment, request });
      return new URL(request.url).pathname === environment.apiPath;
    },
  });
  const host = createWakeWorkerHost(input);
  const response = await host.fetch(
    new Request("https://wiki.example/internal"),
    { apiPath: "/internal", principal: "operator" },
    { waitUntil() {} },
  );
  expect(response.status).toBe(200);
  expect(input.calls.handle).toHaveLength(1);
});

test("fails closed without exposing route, handler, or fallback errors", async () => {
  for (const [overrides, path] of [
    [{ route: () => { throw new Error("routing secret"); } }, "/api/wiki"],
    [{ route: () => "yes" }, "/api/wiki"],
    [{ handle: async () => { throw new Error("database secret"); } }, "/api/wiki"],
    [{ handle: async () => "not a response" }, "/api/wiki"],
    [{ fallback: async () => { throw new Error("asset secret"); } }, "/"],
  ]) {
    const host = createWakeWorkerHost(fixture(overrides));
    const response = await host.fetch(
      new Request(`https://wiki.example${path}`),
      { principal: "editor-1" },
      { waitUntil() {} },
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      error: {
        code: "worker/internal-error",
        message: "The Wake Worker request failed.",
      },
    });
  }
});

test("reports a closed error phase to an injected host error mapper", async () => {
  const phases = [];
  const input = fixture({
    handle: async () => null,
    onError(error, context) {
      phases.push({ error, context });
      return Response.json({ phase: context.phase }, { status: 503 });
    },
  });
  const request = new Request("https://wiki.example/api/wiki", { method: "POST" });
  const environment = { principal: "editor-1" };
  const executionContext = { waitUntil() {} };
  const host = createWakeWorkerHost(input);

  const response = await host.fetch(request, environment, executionContext);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ phase: "handle" });
  expect(phases).toHaveLength(1);
  expect(phases[0].error).toBeInstanceOf(WakeWorkerConfigError);
  expect(phases[0].context).toEqual({
    executionContext,
    phase: "handle",
  });
  expect(Object.isFrozen(phases[0].context)).toBe(true);
});

test("validates the Worker host configuration before serving", () => {
  const valid = fixture();
  for (const input of [
    undefined,
    { handle: valid.handle },
    { route: valid.route },
    { handle: true, route: valid.route },
    { handle: valid.handle, route: true },
    { fallback: true, handle: valid.handle, route: valid.route },
    { handle: valid.handle, onError: true, route: valid.route },
  ]) {
    expect(() => createWakeWorkerHost(input)).toThrow(WakeWorkerConfigError);
  }
});

test("returns a plain 404 when no fallback is installed", async () => {
  const input = fixture();
  const host = createWakeWorkerHost({ handle: input.handle, route: input.route });
  const response = await host.fetch(
    new Request("https://wiki.example/missing"),
    { principal: "editor-1" },
    { waitUntil() {} },
  );
  expect(response.status).toBe(404);
  expect(await response.text()).toBe("");
});
