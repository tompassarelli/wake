import { createServer } from "http";
import { readFile } from "fs";
import { join, extname } from "path";

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

createServer((req, res) => {
  const p = join(".", req.url === "/" ? "/public-js/index.html" : req.url);
  readFile(p, (err, data) => {
    if (err) { res.writeHead(404); res.end(); }
    else { res.writeHead(200, { "Content-Type": types[extname(p)] || "text/plain" }); res.end(data); }
  });
}).listen(8080);
