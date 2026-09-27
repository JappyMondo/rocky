import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
export const runtime = process.env.ROCKY_ADAPTER_ROOT
  ? resolve(process.env.ROCKY_ADAPTER_ROOT, "dist")
  : resolve("dist");
export const load = (path) => import(pathToFileURL(join(runtime, path)).href);
