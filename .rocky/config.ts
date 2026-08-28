/**
 * PROTOTYPE (NG-572) — `.rocky/config.ts`: the data-shaped knobs.
 *
 * The boundary rule this file embodies: config is what you'd change without
 * rethinking the pipeline — caps, how to start the app, harness defaults.
 * Anything with control flow in it belongs in workflow.ts. The workflow
 * imports this module directly; it is plain data, not a DSL.
 */
import { defineConfig } from "@rocky/sdk";

export default defineConfig({
  caps: {
    review: 5,
    ci: 3,
  },
  ui: {
    start: "pnpm dev --port {port}",
    url: "http://localhost:{port}",
  },
  agents: {
    harness: "claude-code",
  },
});
