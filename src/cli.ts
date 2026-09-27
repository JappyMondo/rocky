#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { configure } from "./config/index.js";
const [command, arg] = process.argv.slice(2);
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
  else {
    console.error("Usage: rocky-next identity | config [file.json]");
    process.exitCode = 2;
  }
} catch {
  console.error("Invalid or unavailable configuration/identity");
  process.exitCode = 1;
}
