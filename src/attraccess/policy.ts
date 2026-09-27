export const TARGET = {
  commit: "afa58e8a5eadfb340f317e6ec3227af0cf9b6c54",
  tree: "b1dd957b63d9afab16d3c1b395d7fc28ffb066fb",
  source: "/Users/jappy/.t3/worktrees/Attraccess/t3code-47ed3e60",
  root: "/Users/jappy/.t3/worktrees/rocky/rocky-next/.qualification/attraccess",
  contract: "a63f0b550ae355440b36a71b55c28cc1ed6e19219603340ff809a3283a223177",
  node: "24.19.0",
  pnpm: "10.34.5",
  nodeImage:
    "node@sha256:5820d753d41d0e59f5be24d725ebee0800ebea569ee8da501b208e13ed7f1884",
  mailpitImage:
    "axllent/mailpit@sha256:d5ecbb067db3705fa953d79e1b7f81ef84038df67aba6c52825d8c02a1ea748a",
};
export const LIMITS = {
  setupMs: 1800000,
  serveMs: 240000,
  browserMs: 120000,
  teardownMs: 30000,
  cleanupMs: 3000,
  logBytes: 8388608,
  memoryBytes: 8589934592,
  cpus: 4,
  pids: 512,
  diskMinimumBytes: 21474836480,
  browserContexts: 1,
  leaseMs: 10000,
};
export const GENERATED = [
  "node_modules/",
  ".husky/_/",
  ".nx/",
  "dist/",
  "tmp/",
  "coverage/",
  "storage/",
  ".env",
  ".dev-serve-ports.json",
  "libs/react-query-client/src/lib/",
  "apps/plugins/shelly/dist/",
  "apps/plugins/shelly/package/",
  "apps/api/src/assets/",
  "pnpm-debug.log",
];
export const COMMANDS = {
  bootstrap: ["bash", "scripts/setup-dev-dependencies.sh"],
  migrate: ["pnpm", "nx", "run", "api:migrations-run"],
  client: ["pnpm", "nx", "run", "react-query-client:generate"],
  plugin: ["pnpm", "nx", "run", "plugin-shelly:zip"],
  serve: ["pnpm", "serve"],
};
export function checkPlan(base: string, head: string) {
  if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head))
    throw new Error("frozen-revisions-required");
  return {
    base,
    head,
    repository: "Attraccess/Attraccess",
    environment: COMMANDS,
    laterRequired: [
      "core affected lint,typecheck,test,e2e",
      "CRAP integration/report",
      "plugins lint,test,e2e,pack-test; generators:test; HelloWorld pack fixture",
      "applicable firmware/version/fail2ban/Grafana/Balena/companion/container guards",
      "PR title, aggregate, merge_group current-head receipts",
    ],
    qualification: "environment-only",
  };
}
