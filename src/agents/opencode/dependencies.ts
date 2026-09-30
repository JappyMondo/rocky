import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { digest, identity } from "../../store/json.js";

export const OPENCODE_PLUGIN_INTEGRITY =
  "sha512-fmhqCBJvNt+Vfbx6ckKP19S3xwMBhUXLCBQaK92R4wnv3wsWTZYkJQwYf2egiWfJNOl47jhs3vP7uQkl0mvHQw==";
export interface DependencyTemplate {
  root: string;
  inventorySha256: string;
  lockSha256: string;
  integrity: typeof OPENCODE_PLUGIN_INTEGRITY;
}
/** Complete nonsecret tree inventory; symlinks must resolve inside the dependency tree. */
export function dependencyInventory(root: string): string {
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory())
    throw new Error("opencode-dependency-root");
  const entries: unknown[] = [];
  let count = 0,
    bytes = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (++count > 100000) throw new Error("opencode-dependency-node-limit");
      const path = join(dir, name),
        stat = lstatSync(path),
        key = relative(root, path);
      if (stat.isSymbolicLink()) {
        const target = realpathSync(path);
        if (!target.startsWith(root + "/"))
          throw new Error("opencode-dependency-external-link");
        entries.push([key, "link", readlinkSync(path)]);
      } else if (stat.isDirectory()) {
        entries.push([key, "dir", stat.mode & 0o777]);
        walk(path);
      } else if (stat.isFile()) {
        if (stat.nlink !== 1) throw new Error("opencode-dependency-hardlink");
        bytes += stat.size;
        if (bytes > 256 * 1024 * 1024)
          throw new Error("opencode-dependency-byte-limit");
        entries.push([
          key,
          "file",
          stat.mode & 0o777,
          stat.size,
          digest(readFileSync(path)),
        ]);
      } else throw new Error("opencode-dependency-special-file");
    }
  };
  walk(root);
  return identity(entries);
}
function verifyPackage(root: string) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(
    readFileSync(join(root, "package-lock.json"), "utf8"),
  );
  const installed = JSON.parse(
    readFileSync(
      join(root, "node_modules/@opencode-ai/plugin/package.json"),
      "utf8",
    ),
  );
  if (
    identity(pkg.dependencies) !==
      identity({ "@opencode-ai/plugin": "1.18.33" }) ||
    identity(lock.packages?.[""]?.dependencies) !==
      identity(pkg.dependencies) ||
    lock.packages?.["node_modules/@opencode-ai/plugin"]?.integrity !==
      OPENCODE_PLUGIN_INTEGRITY ||
    lock.packages?.["node_modules/@opencode-ai/plugin"]?.version !==
      "1.18.33" ||
    installed.version !== "1.18.33"
  )
    throw new Error("opencode-dependency-package-pin");
}
export function inspectDependencyTemplate(root: string): DependencyTemplate {
  root = resolve(root);
  const inventorySha256 = dependencyInventory(root);
  verifyPackage(root);
  return {
    root,
    inventorySha256,
    lockSha256: digest(readFileSync(join(root, "package-lock.json"))),
    integrity: OPENCODE_PLUGIN_INTEGRITY,
  };
}
export function verifyDependencyTemplate(template: DependencyTemplate) {
  if (identity(inspectDependencyTemplate(template.root)) !== identity(template))
    throw new Error("opencode-dependency-template-drift");
}
export function materializeDependencies(
  template: DependencyTemplate,
  configHome: string,
) {
  verifyDependencyTemplate(template);
  const destination = join(configHome, "opencode");
  if (!existsSync(destination)) {
    cpSync(template.root, destination, {
      recursive: true,
      verbatimSymlinks: true,
    });
    // Node cp preserves file modes but creates directories using its default mode.
    const preserveDirectories = (source: string, target: string) => {
      chmodSync(target, lstatSync(source).mode & 0o777);
      for (const name of readdirSync(source))
        if (lstatSync(join(source, name)).isDirectory())
          preserveDirectories(join(source, name), join(target, name));
    };
    preserveDirectories(template.root, destination);
  }
  if (dependencyInventory(destination) !== template.inventorySha256)
    throw new Error("opencode-dependency-materialization-drift");
  return destination;
}
/** Credential-free, exact-version bootstrap. Never invokes OpenCode or a package lifecycle script. */
export function prepareDependencyTemplate(
  root: string,
  npmCli: string,
): DependencyTemplate {
  if (
    process.version !== "v24.16.0" ||
    realpathSync(npmCli) !==
      resolve(
        dirname(process.execPath),
        "../lib/node_modules/npm/bin/npm-cli.js",
      )
  )
    throw new Error("opencode-dependency-installer-path");
  root = resolve(root);
  if (existsSync(root))
    throw new Error("opencode-dependency-destination-exists");
  const scratch = root + "-installer";
  mkdirSync(scratch, { mode: 0o700 });
  writeFileSync(join(scratch, "user.npmrc"), "", { flag: "wx", mode: 0o600 });
  writeFileSync(join(scratch, "global.npmrc"), "", { flag: "wx", mode: 0o600 });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: { "@opencode-ai/plugin": "1.18.33" },
    }) + "\n",
    { mode: 0o600 },
  );
  writeFileSync(
    join(root, ".gitignore"),
    "node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore",
    { mode: 0o600 },
  );
  const env = {
    HOME: scratch,
    TMPDIR: scratch,
    PATH: "/usr/bin:/bin",
    LANG: "en_US.UTF-8",
  };
  const base = [
    npmCli,
    "--userconfig=" + join(scratch, "user.npmrc"),
    "--globalconfig=" + join(scratch, "global.npmrc"),
    "--cache=" + join(scratch, "cache"),
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--registry=https://registry.npmjs.org",
  ];
  if (
    execFileSync(process.execPath, [npmCli, "--version"], {
      env,
      encoding: "utf8",
    }).trim() !== "11.13.0"
  )
    throw new Error("opencode-dependency-installer-version");
  execFileSync(process.execPath, [...base, "install", "--package-lock-only"], {
    cwd: root,
    env,
    timeout: 120000,
    stdio: "pipe",
  });
  // npm ci consumes this frozen lock, and the complete installed tree is independently hashed.
  execFileSync(process.execPath, [...base, "ci"], {
    cwd: root,
    env,
    timeout: 120000,
    stdio: "pipe",
  });
  return inspectDependencyTemplate(realpathSync(root));
}
