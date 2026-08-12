import { describe, expect, test } from "bun:test";

import {
  WakeCursorError,
  createWakeCursorProvider,
  createWakeCursorTransport,
} from "./cursor-provider.mjs";

const FINGERPRINT = `sha256:${"a".repeat(64)}`;
const OTHER_FINGERPRINT = `sha256:${"b".repeat(64)}`;
const KEY_A = Uint8Array.from({ length: 32 }, (_, index) => index);
const KEY_B = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const RAW_CURSOR = [
  "triple",
  ["keyword", "cursor"],
  ["triple", ["string", "release"], ["integer", "17"], ["boolean", true]],
  ["instant", "1723456789", "123456789"],
];

function provider(options = {}) {
  return createWakeCursorProvider({
    activeKeyId: "current",
    keys: new Map([["current", KEY_A]]),
    ...options,
  });
}

function sealContext(overrides = {}) {
  return {
    authorizationScope: "tenant:one|role:reader",
    cursor: RAW_CURSOR,
    fingerprint: FINGERPRINT,
    input: { channel: "stable", filters: ["public", 2] },
    options: { limit: 20 },
    query: "releases-by-channel",
    servedVersion: 17n,
    ...overrides,
  };
}

function unsealContext(token, overrides = {}) {
  const sealed = sealContext();
  return {
    authorizationScope: sealed.authorizationScope,
    fingerprint: sealed.fingerprint,
    input: sealed.input,
    options: sealed.options,
    query: sealed.query,
    token,
    ...overrides,
  };
}

async function expectCode(promise, code) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(WakeCursorError);
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected ${code}`);
}

describe("AES-GCM Wake cursor provider", () => {
  test("round-trips an untouched recursive Term and exact bigint served version", async () => {
    const cursors = provider({ now: () => 1_000, ttlMs: 10_000 });
    const token = await cursors.seal(sealContext());

    expect(token.startsWith("wake-cursor-v1.")).toBe(true);
    expect(new TextEncoder().encode(token).byteLength).toBeLessThanOrEqual(16 * 1024);
    expect(await cursors.unseal(unsealContext(token))).toEqual({
      cursor: RAW_CURSOR,
      servedVersion: 17n,
    });
  });

  test("opens old-key tokens after rotation and rejects an unavailable key", async () => {
    const old = createWakeCursorProvider({
      activeKeyId: "old",
      keys: { old: KEY_A },
      now: () => 1_000,
    });
    const token = await old.seal(sealContext());
    const rotated = createWakeCursorProvider({
      activeKeyId: "new",
      keys: new Map([["old", KEY_A], ["new", KEY_B]]),
      now: () => 1_000,
    });
    const retired = createWakeCursorProvider({
      activeKeyId: "new",
      keys: { new: KEY_B },
      now: () => 1_000,
    });

    expect((await rotated.unseal(unsealContext(token))).cursor).toEqual(RAW_CURSOR);
    await expectCode(retired.unseal(unsealContext(token)), "invalid_cursor");
  });

  test("rejects tampering, expiry, and oversized opaque input with one stable code", async () => {
    let now = 1_000;
    const cursors = provider({ now: () => now, ttlMs: 50 });
    const token = await cursors.seal(sealContext());
    const final = token.at(-1);
    const tampered = `${token.slice(0, -1)}${final === "A" ? "B" : "A"}`;

    await expectCode(cursors.unseal(unsealContext(tampered)), "invalid_cursor");
    now = 1_050;
    await expectCode(cursors.unseal(unsealContext(token)), "invalid_cursor");
    await expectCode(
      cursors.unseal(unsealContext("x".repeat(16 * 1024 + 1))),
      "invalid_cursor",
    );
  });

  test("binds fingerprint, query, canonical input, limit, and authorization scope", async () => {
    const cursors = provider({ now: () => 1_000 });
    const token = await cursors.seal(sealContext());
    const mismatches = [
      { fingerprint: OTHER_FINGERPRINT },
      { query: "other-query" },
      { input: { channel: "candidate", filters: ["public", 2] } },
      { input: { filters: ["public", 2], channel: "stable", extra: null } },
      { options: { limit: 21 } },
      { authorizationScope: "tenant:one|role:editor" },
    ];

    for (const mismatch of mismatches) {
      await expectCode(cursors.unseal(unsealContext(token, mismatch)), "invalid_cursor");
    }
    expect((await cursors.unseal(unsealContext(token, {
      input: { filters: ["public", 2], channel: "stable" },
    }))).servedVersion).toBe(17n);
  });

  test("closes context records and enforces recursive depth and encoded-byte bounds", async () => {
    const cursors = provider({ now: () => 1_000 });
    await expectCode(
      cursors.seal({ ...sealContext(), unexpected: true }),
      "cursor_provider_failure",
    );

    let deep = ["string", "leaf"];
    for (let index = 0; index < 257; index += 1) {
      deep = ["triple", ["keyword", "edge"], ["integer", String(index)], deep];
    }
    await expectCode(
      cursors.seal(sealContext({ cursor: deep })),
      "cursor_provider_failure",
    );
    await expectCode(
      cursors.seal(sealContext({ cursor: ["string", "x".repeat(20_000)] })),
      "cursor_provider_failure",
    );

    const token = await cursors.seal(sealContext());
    await expectCode(
      cursors.unseal({ ...unsealContext(token), unexpected: true }),
      "invalid_cursor",
    );
    let deepInput = "value";
    for (let index = 0; index < 34; index += 1) deepInput = { nested: deepInput };
    await expectCode(
      cursors.unseal(unsealContext(token, { input: { deepInput } })),
      "invalid_cursor",
    );
  });

  test("requires an explicit usable 256-bit injected keyring", () => {
    expect(() => createWakeCursorProvider({ activeKeyId: "missing", keys: {} })).toThrow();
    expect(() => createWakeCursorProvider({ activeKeyId: "bad", keys: { bad: new Uint8Array(31) } })).toThrow();
    expect(() => createWakeCursorProvider({
      activeKeyId: "current",
      keys: { current: KEY_A },
      ambientKeyName: "WAKE_CURSOR_KEY",
    })).toThrow();
  });
});

describe("opaque cursor transport", () => {
  test("seals a first-page continuation, then opens it to raw Term plus exact asOf", async () => {
    const cursors = provider({ now: () => 1_000 });
    const transport = createWakeCursorTransport(cursors, { fingerprint: FINGERPRINT });
    const calls = [];
    const baseRequest = {
      authorizationScope: "tenant:one|role:reader",
      input: { channel: "stable" },
      options: { limit: 20 },
      query: "releases-by-channel",
    };
    const first = await transport.execute(baseRequest, async request => {
      calls.push(request);
      return {
        rows: [{ id: "r-1" }],
        page: { done: false, nextCursor: RAW_CURSOR },
        servedVersion: 17n,
      };
    });
    expect(typeof first.page.nextCursor).toBe("string");
    expect(calls[0]).toEqual(baseRequest);

    const second = await transport.execute({
      ...baseRequest,
      options: { limit: 20, cursor: first.page.nextCursor },
    }, async request => {
      calls.push(request);
      return {
        rows: [{ id: "r-2" }],
        page: { done: true, nextCursor: null },
        servedVersion: 17n,
      };
    });
    expect(second.page).toEqual({ done: true, nextCursor: null });
    expect(calls[1]).toEqual({
      ...baseRequest,
      options: { limit: 20, cursor: RAW_CURSOR, asOf: 17n },
    });
  });

  test("rejects every continuation identity mismatch before invoke", async () => {
    const cursors = provider({ now: () => 1_000 });
    const transport = createWakeCursorTransport(cursors, { fingerprint: FINGERPRINT });
    const base = {
      authorizationScope: "tenant:one|role:reader",
      input: { channel: "stable" },
      options: { limit: 20 },
      query: "releases-by-channel",
    };
    const first = await transport.execute(base, async () => ({
      rows: [],
      page: { done: false, nextCursor: RAW_CURSOR },
      servedVersion: 17n,
    }));
    let invokes = 0;
    const invoke = async () => { invokes += 1; };
    const mismatches = [
      { ...base, query: "other-query", options: { ...base.options, cursor: first.page.nextCursor } },
      { ...base, input: { channel: "other" }, options: { ...base.options, cursor: first.page.nextCursor } },
      { ...base, options: { limit: 19, cursor: first.page.nextCursor } },
      {
        ...base,
        authorizationScope: "tenant:one|role:editor",
        options: { ...base.options, cursor: first.page.nextCursor },
      },
    ];
    for (const mismatch of mismatches) {
      await expectCode(transport.execute(mismatch, invoke), "invalid_cursor");
    }
    const otherDeployment = createWakeCursorTransport(cursors, { fingerprint: OTHER_FINGERPRINT });
    await expectCode(otherDeployment.execute({
      ...base,
      options: { ...base.options, cursor: first.page.nextCursor },
    }, invoke), "invalid_cursor");
    expect(invokes).toBe(0);
  });

  test("works without a provider only when no cursor operation is needed", async () => {
    const transport = createWakeCursorTransport(null, { fingerprint: FINGERPRINT });
    const request = {
      authorizationScope: "tenant:one|role:reader",
      input: {},
      options: {},
      query: "release-by-id",
    };
    await expect(transport.execute(request, async () => ({
      row: { id: "r-1" },
      servedVersion: 1n,
    }))).resolves.toEqual({ row: { id: "r-1" }, servedVersion: 1n });

    let invokes = 0;
    await expectCode(transport.execute(request, async () => {
      invokes += 1;
      return {
        rows: [],
        page: { done: false, nextCursor: RAW_CURSOR },
        servedVersion: 1n,
      };
    }), "cursor_provider_unavailable");
    expect(invokes).toBe(1);

    await expectCode(transport.execute({
      ...request,
      options: { cursor: "opaque" },
    }, async () => { invokes += 1; }), "cursor_provider_unavailable");
    expect(invokes).toBe(1);
  });

  test("rejects tampered cursors and missing authorization scope before invoke", async () => {
    const cursors = provider({ now: () => 1_000 });
    const transport = createWakeCursorTransport(cursors, { fingerprint: FINGERPRINT });
    let invokes = 0;
    await expectCode(transport.execute({
      authorizationScope: "tenant:one|role:reader",
      input: {},
      options: { cursor: "not-a-token" },
      query: "releases",
    }, async () => { invokes += 1; }), "invalid_cursor");
    await expectCode(transport.execute({
      authorizationScope: "",
      input: {},
      options: {},
      query: "releases",
    }, async () => { invokes += 1; }), "invalid_request");
    expect(invokes).toBe(0);
  });
});
