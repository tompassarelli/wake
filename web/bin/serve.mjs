const assets = new Map([
  [
    "/test.html",
    {
      file: Bun.file(new URL("../public-js/test.html", import.meta.url)),
      type: "text/html; charset=utf-8",
    },
  ],
  [
    "/dist.css",
    {
      file: Bun.file(new URL("../public-js/dist.css", import.meta.url)),
      type: "text/css; charset=utf-8",
    },
  ],
]);
const portText = process.env.WAKE_BROWSER_PORT ?? "8080";
const portFile = process.env.WAKE_BROWSER_PORT_FILE;
const port = Number(portText);

if (
  !/^[0-9]+$/.test(portText) ||
  !Number.isInteger(port) ||
  port < 0 ||
  port > 65535
) {
  throw new Error(`invalid WAKE_BROWSER_PORT: ${portText}`);
}
if (port === 0 && !portFile) {
  throw new Error("WAKE_BROWSER_PORT=0 requires WAKE_BROWSER_PORT_FILE");
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    }

    const asset = assets.get(new URL(request.url).pathname);
    if (!asset) {
      return new Response(null, { status: 404 });
    }
    if (!(await asset.file.exists())) {
      return new Response(null, { status: 500 });
    }

    return new Response(request.method === "HEAD" ? null : asset.file, {
      headers: { "content-type": asset.type },
    });
  },
  error(error) {
    console.error(error);
    return new Response(null, { status: 500 });
  },
});

if (portFile) {
  await Bun.write(portFile, `${server.port}\n`);
}
