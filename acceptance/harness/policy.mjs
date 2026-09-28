import { join } from "node:path";
import { definition } from "./fixture.mjs";

// Independently reviewed STATIC candidate, Taskbot #63/521 and root #59/522.
// Fixed platform IPC/extensions remain trusted, not filesystem-denied.
export const excludedPlatformRoots = [
  "/tmp",
  "/private/tmp",
  "/var/tmp",
  "/private/var/tmp",
  "/Applications",
  "/etc",
  "/private/etc",
  "/var/db",
  "/private/var/db",
  "/Library/Preferences",
  "/Library/Preferences/Logging",
  "/Library/Filesystems/NetFSPlugins",
  "/opt/homebrew/lib",
  "/usr/local/lib",
];
export function candidatePolicy(attempt) {
  const fixture = definition(attempt);
  const scratch = join(attempt, "scratch"),
    codexHome = join(attempt, "runtime/codex-home");
  const denied = [
    ...excludedPlatformRoots,
    fixture.authority,
    join(codexHome, "config.toml"),
    join(codexHome, "auth.json"),
    join(codexHome, "sessions"),
    join(codexHome, "memories"),
    join(attempt, "loaded-source"),
    join(attempt, "loaded-schema"),
  ];
  const filesystem = {
    ":minimal": "read",
    [fixture.source]: "write",
    [scratch]: "write",
    [join(fixture.source, ".git")]: "read",
  };
  for (const path of denied) {
    filesystem[path] = "deny";
    filesystem[`${path}{,/**}`] = "deny";
  }
  // Never glob-deny the helper parent then assume a read overrides that deny.
  for (const pattern of [
    join(attempt, "*.json"),
    join(attempt, "*.jsonl"),
    join(attempt, "*.toml"),
    join(codexHome, "*.sqlite*"),
    join(codexHome, "logs{,/**}"),
  ])
    filesystem[pattern] = "deny";
  const lines = [
    "[permissions.probe.filesystem]",
    ...Object.entries(filesystem).map(
      ([path, access]) => `${JSON.stringify(path)} = ${JSON.stringify(access)}`,
    ),
    "[permissions.probe.network]",
    "enabled = false",
  ];
  return {
    filesystem,
    lines,
    environment: {
      HOME: join(scratch, "home"),
      TMPDIR: join(scratch, "tmp"),
      CODEX_HOME: codexHome,
    },
    exactPretrust: `[projects.${JSON.stringify(fixture.source)}]\ntrust_level = "trusted"\n`,
    helperBoundary: {
      permittedAutomaticSubtree: join(codexHome, "tmp/arg0"),
      requiredBeforeNativeDispatch:
        "Inventory/hash actual selected wrapper and helper subtree; reject unaccounted symlink targets or authority overlap. No parent-wide read exemption.",
    },
    status: "static-candidate-not-runtime-qualified",
    runtimeSharedTempDenial: "UNPROVEN; no outside-canonical write authority",
    trustedMacOSDependencies:
      "Pinned :minimal executable/framework maps, devices including /dev/fd, named mach/syslog/shared-memory channels and sandbox extensions. No IPC-free or generic network-isolation claim. Explicit deny globs restrict overlapping file read/write grants; filesystem rules cannot remove fixed IPC/map/extension operations.",
  };
}
