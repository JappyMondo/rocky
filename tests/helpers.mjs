import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { Store } from "../dist/index.js";
export const versions = {
  workflow: "wf-1",
  adapter: "aa-1",
  prompt: "p-1",
  runner: "r-1",
  build: "build-A",
};
export const root = resolve(
  process.env.FOUNDATION_ARTIFACT_ROOT ?? ".qualification/tests",
  new Date().toISOString().replaceAll(":", "-") + "-" + process.pid,
);
mkdirSync(root, { recursive: true });
export function fixture(name) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const store = new Store(join(dir, "store.sqlite"));
  store.admit({
    id: "synthetic-001",
    head: "1".repeat(40),
    base: "0".repeat(40),
    scope: "scope-v1",
    versions,
    config: { leaseMs: 500 },
  });
  return { dir, store };
}
export function save(dir, name, data) {
  writeFileSync(
    join(dir, name + ".json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}
export const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value;
    await pause(20);
  }
  throw new Error("condition-timeout");
}
