import { createServer } from "node:http";
import { readFileSync, appendFileSync } from "node:fs";
const [dir, mode] = process.argv.slice(2),
  responses = JSON.parse(readFileSync(`${dir}/response-plan.json`));
let sent = 0;
const server = createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  const body = JSON.parse(text);
  appendFileSync(
    `${dir}/upstream.jsonl`,
    JSON.stringify({
      route: req.url,
      body,
      authMatched:
        req.headers.authorization === "Bearer SYNTHETIC-UPSTREAM-ONLY",
    }) + "\n",
  );
  if (req.url === "/count") {
    if (mode === "count-delay") await new Promise((r) => setTimeout(r, 150));
    res.end(
      JSON.stringify({
        schema: 1,
        digest: mode === "count-mismatch" ? "0".repeat(64) : body.digest,
        inputTokens: 5,
      }),
    );
    return;
  }
  const raw = responses[sent++] ?? responses.at(-1);
  if (mode === "hold") return;
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (mode === "bad-terminal") {
    res.write(raw.slice(0, raw.lastIndexOf("data: ")));
    setTimeout(() => res.end("data: {invalid\n\n"), 40);
    return;
  }
  if (mode === "lost") {
    req.socket.destroy();
    return;
  }
  if (mode === "invalid-utf8") {
    const invalid = Buffer.from(raw);
    invalid[invalid.indexOf("native-probe")] = 255;
    res.end(invalid);
    return;
  }
  if (mode === "fragment") {
    const bytes = Buffer.from(raw);
    let pos = 0;
    const emit = () => {
      if (pos < bytes.length) {
        res.write(bytes.subarray(pos, pos + 1));
        pos++;
        setImmediate(emit);
      } else res.end();
    };
    emit();
  } else res.end(raw);
});
server.listen(0, "127.0.0.1", () =>
  process.send({ port: server.address().port }),
);
process.on("message", (m) => {
  if (m === "close") {
    server.close(() => process.disconnect());
    server.closeAllConnections();
  }
});
process.on("disconnect", () => {
  server.close();
  server.closeAllConnections();
});
