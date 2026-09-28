import { readFileSync, writeFileSync } from "node:fs";
import { Store } from "../dist/index.js";
import { ProviderGateway, provider } from "./stock-support.mjs";
const [dir, stage, port] = process.argv.slice(2);
const { lease, action, contract } = JSON.parse(
  readFileSync(`${dir}/crash-input.json`),
);
const store = new Store(`${dir}/state.sqlite`);
function stop() {
  writeFileSync(
    `${dir}/window.json`,
    JSON.stringify({ stage, pid: process.pid }),
  );
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
for (const [point, method] of [
  ["before-admission", "prepareStockProvider"],
  ["before-accounting", "finishStockProvider"],
])
  if (stage === point) {
    const original = store[method].bind(store);
    store[method] = (...args) => {
      stop();
      return original(...args);
    };
  }
for (const [point, method] of [
  ["after-admission", "prepareStockProvider"],
  ["after-reserve", "reserveProvider"],
  ["after-accounting", "finishStockProvider"],
])
  if (stage === point) {
    const original = store[method].bind(store);
    store[method] = (...args) => {
      const result = original(...args);
      stop();
      return result;
    };
  }
if (stage === "before-forward") {
  const original = store.forwardStockProvider.bind(store);
  store.forwardStockProvider = (...args) => {
    args[4] = stop;
    return original(...args);
  };
}
if (stage === "before-forward-receipt") store.observeStockForward = stop;
const gateway = new ProviderGateway(
  store,
  lease,
  action,
  provider(Number(port), {
    afterCount() {
      if (stage === "after-count") stop();
    },
    beforeSend() {
      if (stage === "before-send") stop();
    },
  }),
  { contract, assertCurrent() {} },
);
process.send(await gateway.listen());
