import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runtime, attemptRoot, ROOT } from "./runtime.mjs";
import { evaluateCycle } from "./evaluator.mjs";
const fixture = process.argv[2];
if (!["member", "fresh_2fa", "fresh_install", "shelly"].includes(fixture))
  throw Error("Specify one fixture for unscored preparation sanity");
const rt = await runtime(),
  { id, root } = attemptRoot(
    "evaluator-sanity-" + fixture.replaceAll("_", "-"),
  );
const manifest = JSON.parse(
  readFileSync(join(ROOT, "acceptance/environment/manifest.json")),
);
const reference = manifest.cycles.find((c) => c.fixture === fixture);
const cycle = {
  ...reference,
  id: "preparation-" + fixture.replaceAll("_", "-"),
};
console.log(
  JSON.stringify({
    id,
    root,
    status: "started",
    scope: "unscored-evaluator-sanity",
  }),
);
const result = await evaluateCycle(rt, cycle, { id, root, preparation: true });
console.log(
  JSON.stringify({
    root,
    status: result.status,
    failedStage: result.failedStage,
    missing: result.missingAssertions,
    scope: result.scope,
  }),
);
if (result.status !== "passed") process.exitCode = 1;
