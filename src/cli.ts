#!/usr/bin/env node
import {
  readFileSync,
  writeFileSync,
  existsSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configure } from "./config/index.js";
import { homePath, setup } from "./daemon/config.js";
import { OperatorService } from "./daemon/service.js";
import { serve } from "./daemon/server.js";
import { identify, matches, delay } from "./runner/process.js";

const [command, arg] = process.argv.slice(2),
  home = homePath(),
  marker = join(home, "daemon.json");
type Marker = {
  process: NonNullable<ReturnType<typeof identify>>;
  url: string;
};
function current(): Marker | null {
  try {
    const m = JSON.parse(readFileSync(marker, "utf8")) as Marker;
    return matches(m.process) ? m : null;
  } catch {
    return null;
  }
}
try {
  if (command === "identity")
    console.log(
      readFileSync(new URL("./build-identity.json", import.meta.url), "utf8"),
    );
  else if (command === "config")
    console.log(
      JSON.stringify(
        configure(arg ? JSON.parse(readFileSync(arg, "utf8")) : {}),
        null,
        2,
      ),
    );
  else if (command === "setup") {
    const report = setup(home);
    const service = new OperatorService(home);
    await service.close();
    console.log(JSON.stringify(report, null, 2));
  } else if (command === "status") {
    const m = current();
    console.log(m ? `Running at ${m.url} (pid ${m.process.pid})` : "Stopped");
  } else if (command === "start") {
    const existing = current();
    if (existing) console.log(existing.url);
    else {
      setup(home);
      const log = openSync(join(home, "daemon.log"), "a", 0o600);
      const child = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), "serve"],
        { detached: true, stdio: ["ignore", log, log], env: process.env },
      );
      child.unref();
      closeSync(log);
      for (let i = 0; i < 100 && !current(); i++) await delay(100);
      const m = current();
      if (!m)
        throw new Error(
          "Daemon did not start. Inspect " + join(home, "daemon.log"),
        );
      console.log(m.url);
    }
  } else if (command === "stop") {
    const m = current();
    if (!m) console.log("Stopped");
    else {
      process.kill(m.process.pid, "SIGTERM");
      for (let i = 0; i < 150 && matches(m.process); i++) await delay(100);
      if (matches(m.process))
        throw new Error(
          "Daemon is still draining owned work; inspect daemon.log",
        );
      console.log("Stopped");
    }
  } else if (command === "serve") {
    if (current()) throw new Error("Daemon already running");
    setup(home);
    // Exclusive startup lock stops two simultaneous `start` calls before either writes its marker.
    const lock = join(home, "daemon.lock");
    let fd: number;
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch {
      throw new Error(
        "Daemon startup lock exists. If no daemon is running, inspect then remove " +
          lock,
      );
    }
    try {
      const service = new OperatorService(home);
      const app = await serve(
        service,
        Number(process.env.ROCKY_NEXT_PORT ?? 4737),
      );
      const processIdentity = identify(process.pid);
      if (!processIdentity) throw new Error("Cannot identify daemon process");
      writeFileSync(
        marker,
        JSON.stringify({ process: processIdentity, url: app.url }),
        { mode: 0o600 },
      );
      console.log(app.url);
      let closing = false;
      const stop = async () => {
        if (closing) return;
        closing = true;
        await app.close();
        if (existsSync(marker)) unlinkSync(marker);
        if (existsSync(lock)) unlinkSync(lock);
        process.exit(0);
      };
      process.on("SIGTERM", () => void stop());
      process.on("SIGINT", () => void stop());
    } catch (e) {
      unlinkSync(lock);
      throw e;
    } finally {
      closeSync(fd);
    }
  } else {
    console.error(
      "Usage: rocky-next setup | start | stop | status | identity | config [file.json]",
    );
    process.exitCode = 2;
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
