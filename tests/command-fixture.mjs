import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
  stdio: "ignore",
});
writeFileSync(process.argv[2], String(child.pid));
console.log("UNIQUE-STDOUT");
console.error("UNIQUE-STDERR");
if (process.argv[3] === "flood")
  for (let i = 0; i < 200; i++) {
    console.log("x".repeat(100));
    console.error("y".repeat(100));
  }
setInterval(() => {}, 1000);
