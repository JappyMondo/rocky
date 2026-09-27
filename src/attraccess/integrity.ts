import {
  readFileSync,
  readdirSync,
  lstatSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { digest, canonical } from "../store/json.js";
const installedRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export function fileTree(
  root: string,
  exclude: readonly string[] = [],
): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name),
        key = relative(root, path).replaceAll("\\", "/");
      if (exclude.includes(key) || name === "node_modules") continue;
      const st = lstatSync(path);
      if (st.isSymbolicLink()) {
        throw Error("runtime-symlink-refused:" + key);
      } else if (st.isDirectory()) walk(path);
      else if (st.isFile()) files[key] = digest(readFileSync(path));
      else throw Error("runtime-file-type:" + key);
    }
  };
  walk(root);
  return files;
}
export function verifyInstalledBuild(root = installedRoot) {
  const build = JSON.parse(
    readFileSync(join(root, "dist/build-identity.json"), "utf8"),
  );
  const { buildId, ...unsigned } = build;
  if (digest(JSON.stringify(unsigned)) !== buildId)
    throw Error("installed-build-metadata-drift");
  const actual = Object.fromEntries(
    Object.entries(fileTree(join(root, "dist"), ["build-identity.json"])).map(
      ([key, value]) => ["dist/" + key, value],
    ),
  );
  if (canonical(actual) !== canonical(build.files))
    throw Error("installed-build-file-drift");
  return { build, inventorySha256: digest(canonical(actual)) };
}
export function dependencyIdentity(root = installedRoot) {
  const trees: Record<
    string,
    { name: string; version: string; files: Record<string, string> }
  > = {};
  const visiting = new Set<string>();
  const walk = (
    name: string,
    from: string,
    optional = false,
  ): string | undefined => {
    const require = createRequire(join(from, "package.json"));
    let path: string;
    try {
      path = require.resolve(name + "/package.json");
    } catch {
      try {
        let entry = dirname(require.resolve(name));
        while (!readablePackage(entry, name)) {
          const parent = dirname(entry);
          if (parent === entry) throw Error("package-root-missing");
          entry = parent;
        }
        path = join(entry, "package.json");
      } catch (error) {
        if (optional) return undefined;
        throw error;
      }
    }
    const directory = dirname(realpathSync(path)),
      pkg = JSON.parse(readFileSync(path, "utf8")),
      key = name + "@" + pkg.version;
    if (visiting.has(directory)) return key;
    visiting.add(directory);
    const entry = { name, version: pkg.version, files: fileTree(directory) };
    if (trees[key] && canonical(trees[key]) !== canonical(entry))
      throw Error("conflicting-runtime-dependency:" + key);
    trees[key] = entry;
    for (const child of Object.keys(pkg.dependencies ?? {}).sort())
      walk(child, directory);
    for (const child of Object.keys(pkg.optionalDependencies ?? {}).sort())
      walk(child, directory, true);
    return key;
  };
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const name of Object.keys(pkg.dependencies ?? {}).sort())
    walk(name, root);
  const driver = Object.fromEntries(
    Object.entries(trees).filter(
      ([, v]) =>
        v.name === "playwright" ||
        v.name === "playwright-core" ||
        v.name === "fsevents",
    ),
  );
  if (!Object.values(driver).some((v) => v.name === "playwright-core"))
    throw Error("driver-core-missing");
  return {
    trees,
    sha256: digest(canonical(trees)),
    driverTreeSha256: digest(canonical(driver)),
    packageSha256: digest(readFileSync(join(root, "package.json"))),
  };
}
function readablePackage(directory: string, name: string) {
  try {
    return (
      JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name ===
      name
    );
  } catch {
    return false;
  }
}
export function runtimeIntegrity(root = installedRoot) {
  const build = verifyInstalledBuild(root),
    dependencies = dependencyIdentity(root);
  return {
    buildId: build.build.buildId,
    installedBuildInventorySha256: build.inventorySha256,
    runtimeDependenciesSha256: dependencies.sha256,
    driverTreeSha256: dependencies.driverTreeSha256,
    packageSha256: dependencies.packageSha256,
  };
}
