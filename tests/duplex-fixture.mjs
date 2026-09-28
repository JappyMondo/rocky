import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync } from "node:fs";
const [mode, dir] = process.argv.slice(2);
writeFileSync(`${dir}/target.pid`, String(process.pid));
const emit = (x) => process.stdout.write(JSON.stringify(x) + "\n");
if (mode === "echo") {
  process.stdin.setEncoding("utf8");
  let pending = "";
  process.stdin.on("data", (chunk) => {
    appendFileSync(`${dir}/received`, chunk);
    pending += chunk;
    while (pending.includes("\n")) {
      const idx = pending.indexOf("\n");
      const line = pending.slice(0, idx);
      pending = pending.slice(idx + 1);
      const wire = JSON.stringify({ echo: JSON.parse(line) }) + "\n";
      process.stdout.write(wire.slice(0, 2));
      process.stdout.write(wire.slice(2));
    }
  });
  process.stdin.on("end", () => {
    emit({ ended: true });
  });
} else if (mode === "multi") process.stdout.write('{"a":"ü"}\n{"b":2}\n');
else if (mode === "malformed") process.stdout.write("{oops}\n");
else if (mode === "oversize")
  process.stdout.write('"' + "x".repeat(4096) + '"\n');
else if (mode === "flood") {
  for (let i = 0; i < 500; i++) emit({ n: i });
} else if (mode === "partial") process.stdout.write('{"partial":');
else if (mode === "invalid-utf8")
  process.stdout.write(Buffer.from([34, 255, 34, 10]));
else if (mode === "stderr") process.stderr.write("e".repeat(100000));
else if (mode === "empty") {
} else if (mode === "hold" || mode === "blocked-input") {
  emit({ ready: true });
  if (mode === "hold")
    process.stdin.on("data", (chunk) =>
      appendFileSync(`${dir}/received`, chunk),
    );
  setInterval(() => {}, 1000);
} else if (mode === "descendant") {
  const child = spawn(
    process.execPath,
    ["-e", 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'],
    { stdio: "ignore" },
  );
  writeFileSync(`${dir}/descendant.pid`, String(child.pid));
  emit({ ready: true });
  process.stdout.end();
  process.stderr.end();
  setInterval(() => {}, 1000);
}
