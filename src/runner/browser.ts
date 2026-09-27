import {
  chromium,
  type Browser,
  type BrowserServer,
  type BrowserContext,
  type Page,
} from "playwright";
import { mkdirSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Evidence } from "../evidence/index.js";
import { digest } from "../store/json.js";
import { identify } from "./process.js";
import type { ProcessIdentity } from "../store/index.js";
export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<unknown>;
  screenshot: (name: string) => Promise<unknown>;
}
export async function openBrowser(
  root: string,
  options: {
    executablePath: string;
    locale: "en" | "de";
    viewport: { width: number; height: number };
    timeoutMs: number;
    onProcess?: (identity: ProcessIdentity) => void;
  },
): Promise<BrowserSession> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const priorTmp = process.env.TMPDIR;
  const temporary = join(root, "temporary");
  mkdirSync(temporary, { mode: 0o700 });
  process.env.TMPDIR = temporary;
  let server: BrowserServer;
  try {
    server = await chromium.launchServer({
      host: "127.0.0.1",
      executablePath: options.executablePath,
      headless: true,
      downloadsPath: join(root, "downloads"),
      timeout: options.timeoutMs,
    });
  } finally {
    if (priorTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = priorTmp;
  }
  const identity = identify(server.process().pid!);
  if (!identity) {
    await server.kill();
    throw new Error("browser-process-identity-missing");
  }
  try {
    options.onProcess?.(identity);
  } catch (error) {
    await server.kill();
    throw error;
  }
  try {
    const browser = await chromium.connect(server.wsEndpoint());
    const context = await browser.newContext({
      serviceWorkers: "block",
      locale: options.locale,
      viewport: options.viewport,
    });
    context.setDefaultTimeout(options.timeoutMs);
    context.setDefaultNavigationTimeout(options.timeoutMs);
    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: false,
    });
    await context.addInitScript((locale) => {
      localStorage.setItem("language", locale);
    }, options.locale);
    const page = await context.newPage();
    let closePromise: Promise<unknown> | undefined;
    const evidence = new Evidence(join(root, "artifacts"));
    return {
      browser,
      context,
      page,
      screenshot: async (name) => {
        if (!/^[a-z0-9-]+$/.test(name))
          throw new Error("invalid-screenshot-name");
        const file = join(root, name + ".png");
        await page.screenshot({
          path: file,
          fullPage: true,
          mask: [
            page.locator(
              'input[type=password],input[autocomplete=one-time-code],[data-cy=two-factor-setup-code-input],canvas,img[src^="data:"]',
            ),
          ],
        });
        chmodSync(file, 0o600);
        return evidence.put(readFileSync(file));
      },
      close: () => {
        if (closePromise) return closePromise;
        closePromise = (async () => {
          const killTimer = setTimeout(
            () => void server.kill().catch(() => {}),
            5000,
          );
          const trace = join(root, "private-trace.zip");
          try {
            await context.tracing.stop({ path: trace });
            chmodSync(trace, 0o600);
            return {
              privacy: "private-auth-artifact",
              traceSha256: digest(readFileSync(trace)),
              trace,
            };
          } finally {
            try {
              await context.close();
              await browser.close();
            } finally {
              await server.close();
              clearTimeout(killTimer);
            }
          }
        })();
        return closePromise;
      },
    };
  } catch (error) {
    await server.kill();
    throw error;
  }
}
