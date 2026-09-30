#!/usr/bin/env node
import { resolve } from "node:path";
import { runCurrentChecks } from "./current.js";
const [phase, root, base] = process.argv.slice(2);
try {
  if (!["baseline", "product"].includes(phase ?? "") || !root || !base)
    throw new Error(
      "ATT-764 recipe requires phase, owned root and frozen base",
    );
  console.log(
    JSON.stringify(
      await runCurrentChecks(
        process.cwd(),
        resolve(root),
        phase as "baseline" | "product",
        base,
      ),
    ),
  );
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
