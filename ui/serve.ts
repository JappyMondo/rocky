/** PROTOTYPE (NG-573) — one command, no build, no deps. `bun run ui`. */
const PORT = 4173;
Bun.serve({
  port: PORT,
  fetch(req) {
    const p = new URL(req.url).pathname;
    const file = Bun.file(`${import.meta.dir}${p === "/" ? "/index.html" : p}`);
    return new Response(file, { headers: { "cache-control": "no-store" } });
  },
});
console.log(`\n  Rocky UI prototype (NG-573)\n\n  http://localhost:${PORT}/?variant=A\n  ←/→ switches variant · \` dumps the raw journal\n`);
