import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writePrivate } from "./runtime.mjs";

// Unscored preparation only. Never constructs AdmissionApproval or calls runScenario.
export async function preparationBrowser(
  runtime,
  environment,
  session,
  options,
  execute,
) {
  if (environment.authority.purpose !== "preparation")
    throw Error("preparation-only");
  const { api, internal } = runtime;
  const commands = environment.commands;
  const key =
    environment.attemptId + "/independent-preparation-browser/" + randomUUID();
  commands.store.transition(commands.lease, "unscored-browser-intent", {
    key,
    kind: "unscored-owned-browser",
    payload: { locale: options.locale, viewport: options.viewport },
  });
  let result, failure;
  const effect = await commands.store.dispatch(commands.lease, key, {
    begin: async () => {
      try {
        commands.store.assertLease(commands.lease);
        const browserRoot = join(
          commands.root,
          "private-browser-" + randomUUID(),
        );
        const browser = await api.openBrowser(browserRoot, {
          executablePath: environment.prepared.browserExecutable,
          locale: options.locale,
          viewport: options.viewport,
          timeoutMs: api.LIMITS.browserMs,
          onProcess: (identity) => {
            commands.store.assertLease(commands.lease);
            if (
              (environment.ownership.browsers ?? []).some(
                runtime.processIdentity.matches,
              )
            )
              throw Error("browser-capacity");
            (environment.ownership.browsers ??= []).push(identity);
            internal.persistOwnership(environment.ownership);
          },
        });
        const denied = [];
        await browser.context.route("**/*", async (route) => {
          try {
            commands.store.assertLease(commands.lease);
          } catch {
            return route.abort("aborted");
          }
          const url = new URL(route.request().url());
          if (
            [session.frontendUrl, session.apiUrl].includes(url.origin) ||
            ["data:", "blob:"].includes(url.protocol)
          )
            return route.continue();
          denied.push({ origin: url.origin, method: route.request().method() });
          return route.abort("blockedbyclient");
        });
        let timer;
        try {
          result = await Promise.race([
            execute(browser),
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                commands.store.cancel(commands.lease.runId);
                void browser.close().catch(() => {});
                reject(Error("preparation-browser-deadline"));
              }, api.LIMITS.browserMs);
            }),
          ]);
          return { scope: "unscored-preparation", completed: true };
        } catch (error) {
          failure = error;
          await browser
            .screenshot("preparation-failure-masked")
            .catch(() => {});
          throw error;
        } finally {
          clearTimeout(timer);
          const trace = await browser.close();
          writePrivate(join(browserRoot, "receipt.json"), {
            scope: "unscored-preparation",
            trace,
            denied,
          });
        }
      } catch (error) {
        failure = error;
        throw error;
      }
    },
  });
  if (effect.state !== "confirmed")
    throw failure ?? Error("preparation-browser-unresolved");
  return result;
}
