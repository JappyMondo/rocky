export const TARGET = {
  commit: "e5b6170088e07ef29fd35c552ea67d18d52ccf27",
  tree: "c2e8704c720590bf90553145722f7e6038de4f70",
  source:
    "/Users/jappy/.t3/worktrees/rocky/rocky-next/.qualification/attraccess/fixture-layout-baseline",
  root: "/Users/jappy/.t3/worktrees/rocky/rocky-next/.qualification/attraccess",
  contract: "43a58eae6306ce23b5c9eff9d86a59798ef5846e380d3f40cd8c50140fccde51",
  provenance: {
    authorityTicket: 40,
    authorityComment: 293,
    originalSource: "/Users/jappy/.t3/worktrees/Attraccess/t3code-47ed3e60",
    originalCommit: "afa58e8a5eadfb340f317e6ec3227af0cf9b6c54",
    originalTree: "b1dd957b63d9afab16d3c1b395d7fc28ffb066fb",
    originalInventorySha256:
      "12e8f5e46b91eaf4949d097b51b1582302a12796287fbd7316e933fd7cb699c5",
    fixtureInventorySha256:
      "f776edd233f8688776e6db4998491d167021d8e3436f2b3eb03efac6c8cd602f",
    changedFile:
      "apps/frontend/src/components/CommunityLicenseButton/index.tsx",
    preimageSha256:
      "fe01a93dfa57f0ba91f1019cbf1cf9bce7ae15b22bc1ca57298d150ee2b1694a",
    postimageSha256:
      "f64704b6df6ef06c01427fb9451e3aaf46c5929e3ab00e0717fcca02b7b7864a",
    patchSha256:
      "857a72b12ddde5e9556beb301ee160b59720f572b9c7ce1f542e22844f062ed5",
  },
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
