/** PROTOTYPE (NG-573) — one command, no build, no deps. `bun run ui`. */
const PORT = Number(process.env.PORT ?? 4173);
const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/favicon.ico") return new Response(null, { status: 204 });
    const file = Bun.file(`${import.meta.dir}${p === "/" ? "/index.html" : p}`);
    return new Response(file, { headers: { "cache-control": "no-store" } });
  },
});
console.log(`\n  Rocky UI prototype (NG-573)\n\n  http://localhost:${server.port}/?variant=A\n  \u2190/\u2192 switches variant \u00b7 ` + "`" + ` dumps the raw journal\n`);
