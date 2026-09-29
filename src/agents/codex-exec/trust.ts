import { readFileSync } from "node:fs";
import { join } from "node:path";
import { digest } from "../../store/json.js";
import { assertCodexOverridePath, type TomlValue } from "./overrides.js";

/**
 * Trust-persistence prevention (S01/S10; acceptance/subscription manifest auth.trustPersistence,
 * source #92/857 F5 and #92/858 §A). In the pinned source, thread/start with a requested writable
 * cwd and no trust_level persists `projects."<git-root-or-cwd>".trust_level="trusted"` into the
 * shared CODEX_HOME config.toml — with a shared store this MUTATES THE USER'S REAL CONFIG. The
 * profile prevents it three ways, all required together:
 *   1. an explicit `projects.<canonical staged root>.trust_level="untrusted"` override
 *      (trust_level Some ⇒ no persistence), rendered here;
 *   2. a PROJECTLESS staged tree (no .git in SRC/RUN or any ancestor — enforced in discovery/paths);
 *   3. a post-run byte check that the shared config.toml is unchanged (captured/compared here).
 * Rocky never reads the config.toml CONTENT beyond a nonsecret sha256/size measurement performed by
 * the host; the bytes are not retained. Native proof that config.toml is unchanged is N01.
 */
export interface SharedConfigTomlMeasurement {
  path: string;
  /** sha256 of the nonsecret config bytes, or null when the file is absent. */
  sha256: string | null;
  bytes: number;
}
/** The explicit untrusted override for the canonical staged root (trust_level Some ⇒ no persist). */
export function codexUntrustedProjectsOverride(src: string): {
  key: "projects";
  value: TomlValue;
} {
  assertCodexOverridePath(src, "src");
  return { key: "projects", value: { [src]: { trust_level: "untrusted" } } };
}
/** Measure the shared config.toml bytes (nonsecret hash + size only; content never retained). */
export function captureSharedConfigToml(
  codexHome: string,
): SharedConfigTomlMeasurement {
  const path = join(codexHome, "config.toml");
  try {
    const bytes = readFileSync(path);
    return { path, sha256: digest(bytes), bytes: bytes.length };
  } catch {
    return { path, sha256: null, bytes: 0 };
  }
}
/** Post-run (C5) comparison: any change to the shared config.toml makes the result stale/unknown. */
export function sharedConfigTomlDrift(
  pre: SharedConfigTomlMeasurement,
  post: SharedConfigTomlMeasurement,
): string | null {
  if (pre.path !== post.path)
    throw new Error("codex-shared-config-path-changed");
  if (pre.sha256 !== post.sha256 || pre.bytes !== post.bytes)
    return "shared-config-toml-mutated";
  return null;
}
