import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requireObservation as need } from "./assertions.mjs";
import { sha } from "./runtime.mjs";

// Read-only /proc observations run inside the owned application container.
const program = String.raw`const fs=require('fs');
const processes=fs.readdirSync('/proc').filter(n=>/^\d+$/.test(n)).flatMap(pid=>{try{const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ').at(-1).split(' ');return [{pid:Number(pid),ppid:Number(stat[1]),startTicks:stat[19]}]}catch{return []}});
const sockets=['/proc/net/tcp','/proc/net/tcp6'].flatMap(p=>fs.readFileSync(p,'utf8').trim().split('\n').slice(1).map(l=>l.trim().split(/\s+/))).filter(r=>r[3]==='0A'&&[3000,4200].includes(parseInt(r[1].split(':')[1],16))).map(r=>({port:parseInt(r[1].split(':')[1],16),inode:r[9],owners:[]}));
for(const p of processes){try{for(const fd of fs.readdirSync('/proc/'+p.pid+'/fd')){let link;try{link=fs.readlinkSync('/proc/'+p.pid+'/fd/'+fd)}catch{continue}for(const socket of sockets)if(link==='socket:['+socket.inode+']')socket.owners.push(p.pid)}}catch{}}
console.log(JSON.stringify({processes,sockets}));`;
export async function observeService(env, s) {
  const result = await env.exec(s, ["node", "-e", program]);
  return { ...JSON.parse(result.stdout), commandId: result.record.id };
}
export async function readyService(env, s) {
  const observed = await observeService(env, s);
  const manifestPath = join(s.serviceRoot, "serve-process.json");
  const manifest = JSON.parse(readFileSync(manifestPath));
  need(
    /^\/app\/\.nx\/rocky-service-\d+$/.test(s.nxWorkspaceDataDirectory) &&
      manifest.nxWorkspaceDataDirectory === s.nxWorkspaceDataDirectory,
    "environment_failed",
    "ENV04",
    "service-generation-mismatch",
  );
  for (const port of [3000, 4200]) {
    const listeners = observed.sockets.filter((x) => x.port === port);
    need(
      listeners.length > 0 && listeners.every((x) => x.owners.length > 0),
      "environment_failed",
      "ENV04",
      "missing-live-listener",
    );
    for (const pid of listeners.flatMap((x) => x.owners)) {
      let current = observed.processes.find((x) => x.pid === pid);
      const ancestors = new Set();
      while (current && !ancestors.has(current.pid)) {
        ancestors.add(current.pid);
        current = observed.processes.find((x) => x.pid === current.ppid);
      }
      need(
        ancestors.has(manifest.pid),
        "environment_failed",
        "ENV04",
        "listener-not-owned-service-descendant",
      );
    }
  }
  return {
    ...observed,
    directory: s.nxWorkspaceDataDirectory,
    manifestPath,
    manifestSha256: sha(readFileSync(manifestPath)),
  };
}
export function automaticExit(before, after, newLog) {
  const cleanLog = newLog.replace(/\x1b\[[0-9;]*m/g, "");
  const owners = before.sockets
    .filter((x) => x.port === 3000)
    .flatMap((x) => x.owners);
  const exited =
    owners.length > 0 &&
    owners.every((pid) => {
      const old = before.processes.find((x) => x.pid === pid);
      return (
        old &&
        !after.processes.some(
          (x) => x.pid === pid && x.startTicks === old.startTicks,
        )
      );
    });
  need(
    exited &&
      !after.sockets.some((x) => x.port === 3000) &&
      owners.some((pid) =>
        new RegExp(
          "\\[Nest\\] " +
            pid +
            " .*\\[PluginService\\].*Restarting app by exiting",
        ).test(cleanLog),
      ) &&
      /api:.*Process exited with code 0, waiting for changes to restart/.test(
        cleanLog,
      ),
    "product_failed",
    "ENV11",
    "automatic-plugin-process-exit-unobserved",
  );
  return {
    exitedOwners: owners,
    noApiListener: true,
    explicitExitCode: 0,
    appendedLogSha256: sha(newLog),
    observationCommandId: after.commandId,
  };
}
