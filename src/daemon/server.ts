import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync } from "node:fs";
import { OperatorService } from "./service.js";

export async function serve(service: OperatorService, port = 4737) {
  const clients = new Set<ServerResponse>();
  let origin = "";
  const server = createServer(async (req, res) => {
    try {
      // Loopback alone is not CSRF protection: reject foreign Host, Origin and fetch context.
      if (req.headers.host !== new URL(origin).host)
        throw new Error("Invalid local host");
      if (req.headers.origin && req.headers.origin !== origin)
        throw new Error("Foreign origin refused");
      if (req.headers["sec-fetch-site"] === "cross-site")
        throw new Error("Cross-site request refused");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
      const path = new URL(req.url ?? "/", origin).pathname;
      if (req.method === "GET" && path === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          Connection: "keep-alive",
        });
        res.write("event: change\ndata: {}\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      const json = (data: unknown, status = 200) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (req.method === "GET" && path === "/api/config")
        return json(service.config());
      if (req.method === "PUT" && path === "/api/config")
        return json(service.configure(await body(req)));
      if (req.method === "GET" && path === "/api/preflight")
        return json(await service.preflight());
      if (req.method === "GET" && path === "/api/runs")
        return json(service.runs());
      if (req.method === "POST" && path === "/api/runs") {
        await body(req);
        return json(await service.start(), 201);
      }
      if (req.method === "GET" && path === "/setup") {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(
          readFileSync(new URL("../../docs/operating.md", import.meta.url)),
        );
        return;
      }
      const match =
        /^\/api\/runs\/([a-f0-9-]+)(?:\/(refresh|approve|merge|closeout|cancel))?$/.exec(
          path,
        );
      if (match) {
        const id = match[1]!;
        if (req.method === "GET" && !match[2]) return json(service.detail(id));
        if (req.method === "POST") {
          const value = (await body(req)) as Record<string, unknown>;
          switch (match[2]) {
            case "refresh":
              return json(await service.refresh(id));
            case "approve":
              if (typeof value.head !== "string")
                throw new Error("Exact head required");
              return json(await service.approve(id, value.head));
            case "merge":
              if (typeof value.head !== "string")
                throw new Error("Exact head required");
              return json(await service.merge(id, value.head));
            case "closeout":
              if (typeof value.note !== "string")
                throw new Error("Closeout note required");
              return json(service.closeout(id, value.note));
            case "cancel":
              await service.cancel(id);
              return json(service.detail(id));
          }
        }
      }
      if (
        req.method === "GET" &&
        ["/", "/app.js", "/style.css"].includes(path)
      ) {
        const name = path === "/" ? "index.html" : path.slice(1);
        res.setHeader(
          "Content-Type",
          name.endsWith(".html")
            ? "text/html; charset=utf-8"
            : name.endsWith(".js")
              ? "text/javascript; charset=utf-8"
              : "text/css; charset=utf-8",
        );
        res.end(readFileSync(new URL("../web/" + name, import.meta.url)));
        return;
      }
      json({ error: "Not found" }, 404);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (error as Error).message }));
      } else res.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local port");
  origin = `http://127.0.0.1:${address.port}`;
  const change = () => {
    for (const client of clients) client.write("event: change\ndata: {}\n\n");
  };
  service.on("change", change);
  const heartbeat = setInterval(() => {
    for (const c of clients) c.write(": heartbeat\n\n");
  }, 15000);
  heartbeat.unref();
  return {
    url: origin,
    server,
    async close() {
      clearInterval(heartbeat);
      service.off("change", change);
      for (const c of clients) c.end();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await service.close();
    },
  };
}
async function body(req: IncomingMessage) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new Error("JSON content type required");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 65536) throw new Error("Request too large");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}
