import { readFileSync, writeFileSync } from "node:fs";
import { Store, ProviderGateway, body, provider } from "./provider-support.mjs";
const [dir, stage, port] = process.argv.slice(2);
const { lease, action } = JSON.parse(readFileSync(`${dir}/crash-input.json`));
const store = new Store(`${dir}/state.sqlite`);
function stop(point) {
  writeFileSync(
    `${dir}/window.json`,
    JSON.stringify({ stage: point, pid: process.pid }),
  );
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
if (stage === "before-prepare") {
  const original = store.prepareProvider.bind(store);
  store.prepareProvider = (...args) => {
    stop(stage);
    return original(...args);
  };
}
if (stage === "after-reserve") {
  const original = store.reserveProvider.bind(store);
  store.reserveProvider = (...args) => {
    const r = original(...args);
    stop(stage);
    return r;
  };
}
if (stage === "before-receipt" || stage === "after-receipt") {
  const original = store.finishProvider.bind(store);
  store.finishProvider = (...args) => {
    if (args[2].state === "completed" && stage === "before-receipt")
      stop(stage);
    const r = original(...args);
    if (args[2].state === "completed" && stage === "after-receipt") stop(stage);
    return r;
  };
}
const upstream = provider(Number(port), {
  beforeCount() {
    if (stage === "before-count") stop(stage);
  },
  afterCount() {
    if (stage === "before-reserve") stop(stage);
  },
  beforeSend() {
    if (stage === "before-send") stop(stage);
  },
});
const gateway = new ProviderGateway(store, lease, action, upstream);
const frozen = gateway.approve({
  id: "crash",
  body,
  outputCap: 60,
  assertCurrent() {},
});
const local = await gateway.listen();
process.send({ ...local, body: frozen.body });
