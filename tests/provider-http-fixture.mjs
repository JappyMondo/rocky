import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
const [dir, mode = "normal"] = process.argv.slice(2);
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const parsed = JSON.parse(body);
  appendFileSync(
    `${dir}/upstream.jsonl`,
    JSON.stringify({
      route: req.url,
      body: parsed,
      authMatched:
        req.headers.authorization === "Bearer SYNTHETIC-UPSTREAM-ONLY",
    }) + "\n",
  );
  process.send?.({ event: "received", route: req.url });
  if (req.headers.authorization !== "Bearer SYNTHETIC-UPSTREAM-ONLY") {
    res.writeHead(403);
    res.end();
    return;
  }
  if (req.url === "/count") {
    if (mode === "count-lost") return;
    if (mode === "count-delay") await new Promise((r) => setTimeout(r, 180));
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        mode === "count-fail"
          ? { error: "SYNTHETIC-UPSTREAM-ONLY" }
          : {
              schema: 1,
              digest:
                mode === "count-mismatch" ? "0".repeat(64) : parsed.digest,
              inputTokens: mode === "count-malformed" ? "40" : 40,
            },
      ),
    );
    return;
  }
  if (req.url !== "/generate") {
    res.writeHead(404);
    res.end();
    return;
  }
  if (mode === "redirect") {
    res.writeHead(307, { location: "http://127.0.0.1:1/forbidden" });
    res.end();
    return;
  }
  if (mode === "lost") {
    req.socket.destroy();
    return;
  }
  if (mode === "delay" || mode === "continued")
    await new Promise((r) => setTimeout(r, 250));
  if (mode === "forever") return;
  res.writeHead(200, { "content-type": "text/event-stream" });
  const state = mode === "incomplete" ? "incomplete" : "completed";
  const delta = { type: "response.output_text.delta", delta: "synthetic" };
  const final = {
    type: `response.${state}`,
    response: {
      model: parsed.model,
      status: state,
      usage: {
        input_tokens: 40,
        output_tokens: 5,
        reasoning_tokens: 3,
        total_tokens: 45,
      },
    },
  };
  if (mode === "unknown") final.response.usage = null;
  if (mode === "usage-over")
    final.response.usage = {
      input_tokens: 40,
      output_tokens: 999,
      reasoning_tokens: 3,
      total_tokens: 1039,
    };
  if (mode === "bad-model") final.response.model = "unexpected";
  if (mode === "event-oversize") delta.delta = "x".repeat(65536);
  const bytes =
    `event: ${delta.type}\ndata: ${JSON.stringify(delta)}\n\n` +
    (mode === "partial"
      ? "data: {"
      : `event: ${final.type}\ndata: ${JSON.stringify(final)}\n\n`) +
    (mode === "late" ? "data: {}\n\n" : "");
  if (mode === "too-many-events") {
    res.end(
      `event: ${delta.type}\ndata: ${JSON.stringify(delta)}\n\n`.repeat(1025),
    );
    return;
  }
  if (mode === "oversize") res.end("x".repeat(1048577));
  else {
    res.write(bytes.slice(0, 17));
    setTimeout(() => res.end(bytes.slice(17)), 10);
  }
  appendFileSync(
    `${dir}/upstream-completion.jsonl`,
    JSON.stringify({ attempted: true, mode }) + "\n",
  );
});
server.listen(0, "127.0.0.1", () =>
  process.send?.({ port: server.address().port }),
);
process.on("message", (message) => {
  if (message === "close") {
    server.close(() => process.disconnect?.());
    server.closeAllConnections();
  }
});
process.on("disconnect", () => {
  server.close();
  server.closeAllConnections();
});
