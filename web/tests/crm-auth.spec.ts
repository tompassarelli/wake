import { test, expect } from "@playwright/test";
import { spawn, ChildProcess } from "child_process";
import { rmSync } from "fs";
import { join } from "path";

const serverDir = join(__dirname, "..", "public-auth");
const PORT = 3458;
const BASE = `http://localhost:${PORT}`;
let server: ChildProcess;

test.beforeAll(async () => {
  try { rmSync(join(serverDir, "app.db"), { force: true }); } catch {}
  try { rmSync(join(serverDir, "app.db-wal"), { force: true }); } catch {}
  try { rmSync(join(serverDir, "app.db-shm"), { force: true }); } catch {}

  server = spawn("node", ["server.js"], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(PORT) },
    stdio: "pipe",
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server start timeout")), 5000);
    server.stdout?.on("data", (data: Buffer) => {
      if (data.toString().includes("http://localhost")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.stderr?.on("data", () => {});
    server.on("error", reject);
  });
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
});

test.describe.serial("Auth: register, login, sessions, protection", () => {
  test("register creates user and sets session cookie", async ({ request }) => {
    const res = await request.post(`${BASE}/api/auth/register`, {
      data: { email: "alice@test.com", password: "pass123", name: "Alice" },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.eid).toBe(1);
    expect(body.email).toBe("alice@test.com");
    expect(body.name).toBe("Alice");
    expect(body.password).toBeUndefined();

    const cookies = res.headers()["set-cookie"];
    expect(cookies).toContain("session=");
  });

  test("duplicate register returns 409", async ({ request }) => {
    const res = await request.post(`${BASE}/api/auth/register`, {
      data: { email: "alice@test.com", password: "other", name: "Alice2" },
    });
    expect(res.status()).toBe(409);
  });

  test("login with correct credentials returns user", async ({ request }) => {
    const res = await request.post(`${BASE}/api/auth/login`, {
      data: { email: "alice@test.com", password: "pass123" },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.email).toBe("alice@test.com");
    expect(body.password).toBeUndefined();

    const cookies = res.headers()["set-cookie"];
    expect(cookies).toContain("session=");
  });

  test("login with wrong password returns 401", async ({ request }) => {
    const res = await request.post(`${BASE}/api/auth/login`, {
      data: { email: "alice@test.com", password: "wrong" },
    });
    expect(res.status()).toBe(401);
  });

  test("me without cookie returns 401", async ({ request }) => {
    const res = await request.get(`${BASE}/api/auth/me`, {
      headers: { cookie: "" },
    });
    expect(res.status()).toBe(401);
  });

  test("me with valid session returns user", async ({ request }) => {
    const loginRes = await request.post(`${BASE}/api/auth/login`, {
      data: { email: "alice@test.com", password: "pass123" },
    });
    const cookie = loginRes.headers()["set-cookie"];
    const sessionToken = cookie.split(";")[0];

    const meRes = await request.get(`${BASE}/api/auth/me`, {
      headers: { cookie: sessionToken },
    });
    expect(meRes.status()).toBe(200);
    const body = await meRes.json();
    expect(body.email).toBe("alice@test.com");
    expect(body.password).toBeUndefined();
  });

  test("protected route without auth returns 401", async ({ request }) => {
    const res = await request.get(`${BASE}/api/contacts`, {
      headers: { cookie: "" },
    });
    expect(res.status()).toBe(401);
  });

  test("protected route with auth returns 200", async ({ request }) => {
    const loginRes = await request.post(`${BASE}/api/auth/login`, {
      data: { email: "alice@test.com", password: "pass123" },
    });
    const cookie = loginRes.headers()["set-cookie"].split(";")[0];

    const res = await request.get(`${BASE}/api/contacts`, {
      headers: { cookie },
    });
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("auth entity has no CRUD routes (security)", async ({ request }) => {
    const res = await request.get(`${BASE}/api/users`, {
      headers: { cookie: "" },
    });
    expect(res.status()).toBe(404);
  });

  test("logout invalidates session", async ({ request }) => {
    const loginRes = await request.post(`${BASE}/api/auth/login`, {
      data: { email: "alice@test.com", password: "pass123" },
    });
    const cookie = loginRes.headers()["set-cookie"].split(";")[0];

    await request.post(`${BASE}/api/auth/logout`, {
      headers: { cookie },
    });

    const meRes = await request.get(`${BASE}/api/auth/me`, {
      headers: { cookie },
    });
    expect(meRes.status()).toBe(401);
  });

  test("CRUD on protected entity requires auth", async ({ request }) => {
    const loginRes = await request.post(`${BASE}/api/auth/login`, {
      data: { email: "alice@test.com", password: "pass123" },
    });
    const cookie = loginRes.headers()["set-cookie"].split(";")[0];

    const createRes = await request.post(`${BASE}/api/contacts`, {
      headers: { cookie },
      data: { name: "Bob", email: "bob@x.com", company: "Corp", status: "active" },
    });
    expect(createRes.status()).toBe(201);

    const noAuthCreate = await request.post(`${BASE}/api/contacts`, {
      headers: { cookie: "" },
      data: { name: "Eve", email: "eve@x.com", company: "Evil", status: "active" },
    });
    expect(noAuthCreate.status()).toBe(401);
  });

  test("health endpoint always accessible", async ({ request }) => {
    const res = await request.get(`${BASE}/health`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});
