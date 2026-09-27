import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, sha } from "./runtime.mjs";
export function evaluatorFiles() {
  return Object.fromEntries(
    readdirSync(join(ROOT, "acceptance/environment"))
      .sort()
      .map((n) => [
        join(ROOT, "acceptance/environment", n),
        sha(readFileSync(join(ROOT, "acceptance/environment", n))),
      ]),
  );
}
export function concrete(value, path = "binding") {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    (typeof value === "string" &&
      /^(pending|unknown|unfrozen|placeholder)$/i.test(value) &&
      !/(rawStatus|assessment)$/.test(path))
  )
    throw Error("missing-concrete-identity:" + path);
  if (typeof value === "object")
    for (const [key, child] of Object.entries(value))
      concrete(child, path + "." + key);
}
export function verifyFiles(files) {
  for (const [path, expected] of Object.entries(files))
    if (sha(readFileSync(path)) !== expected)
      throw Error("bound-file-drift:" + path);
}
