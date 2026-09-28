import { spawn, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const [mode, dir] = process.argv.slice(2);
const identity = () => ({
  pid: process.pid,
  pgid: Number(
    execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "pgid="], {
      encoding: "utf8",
    }).trim(),
  ),
});
writeFileSync(`${dir}/direct.json`, JSON.stringify(identity()));
if (mode === "partial-holder" || mode === "complete-holder") {
  const holder = spawn(
    process.execPath,
    [
      "-e",
      `
    const {writeFileSync}=require('node:fs');
    const {execFileSync}=require('node:child_process');
    const dir=process.argv[1];
    process.on('SIGTERM',()=>writeFileSync(dir+'/holder-ignored-term','yes'));
    writeFileSync(dir+'/holder.json',JSON.stringify({pid:process.pid,pgid:Number(execFileSync('/bin/ps',['-p',String(process.pid),'-o','pgid='],{encoding:'utf8'}).trim())}));
    process.send('ready');setInterval(()=>{},1000);
  `,
      dir,
    ],
    { stdio: ["ignore", "inherit", "inherit", "ipc"] },
  );
  holder.once("message", () => {
    holder.disconnect();
    holder.unref();
    process.stdout.write(
      mode === "partial-holder" ? '{"partial":' : '{"complete":true}\n',
      () => {
        setTimeout(() => process.exit(0), 100);
      },
    );
  });
} else if (mode === "complete") {
  process.stdout.end('{"complete":true}\n');
  process.stderr.end("complete stderr\n");
} else if (mode === "cancel") {
  process.stdout.write('{"partial":');
  setInterval(() => {}, 1000);
}
