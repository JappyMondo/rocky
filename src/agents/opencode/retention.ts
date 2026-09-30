import {
  openSync,
  closeSync,
  fsyncSync,
  writeFileSync,
  readFileSync,
  linkSync,
  unlinkSync,
  lstatSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { digest } from "../../store/json.js";
/** Publish once with fsync; a pre-existing different artifact is a retention failure. */
export function retainImmutable(path: string, input: string | Uint8Array) {
  const bytes = Buffer.from(input),
    temporary = path + "." + randomUUID();
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (
        !lstatSync(path).isFile() ||
        lstatSync(path).isSymbolicLink() ||
        !readFileSync(path).equals(bytes)
      )
        throw new Error("opencode-evidence-conflict");
    }
    const dir = openSync(dirname(path), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } finally {
    unlinkSync(temporary);
  }
  return { path, sha256: digest(bytes), bytes: bytes.length };
}
