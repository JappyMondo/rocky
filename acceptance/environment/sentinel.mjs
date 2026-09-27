import { requireObservation as need } from "./assertions.mjs";
// Independent owner, never included in the environment-under-test's labels.
export async function sentinel(rt, id, authority) {
  const env = new rt.api.AttraccessEnvironment(
    rt.inputs.prepared,
    id + "-sentinel",
    authority,
  );
  const name = env.ownership.owner + "-sentinel";
  env.ownership.containers.push(name);
  rt.internal.persistOwnership(env.ownership);
  try {
    await env.commands.mutation(
      [
        "create",
        "--name",
        name,
        "--label",
        "rocky-next.owner=" + env.ownership.owner,
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        "67108864",
        "--pids-limit",
        "16",
        rt.inputs.prepared.devImage,
        "node",
        "-e",
        "setInterval(()=>{},1000)",
      ],
      "sentinel-create",
    );
    await env.commands.mutation(["start", name], "sentinel-start");
    const inspect = () =>
      JSON.parse(
        rt.internal.dockerRead(env.ownership, ["container", "inspect", name]),
      )[0];
    const before = inspect();
    need(
      before.State.Running,
      "isolation_failed",
      "ENV05",
      "sentinel-not-running",
    );
    return {
      name,
      env,
      before: {
        id: before.Id,
        startedAt: before.State.StartedAt,
        owner: env.ownership.owner,
      },
      verify() {
        const after = inspect();
        need(
          after.Id === before.Id &&
            after.State.StartedAt === before.State.StartedAt &&
            after.State.Running &&
            after.Config.Labels["rocky-next.owner"] === env.ownership.owner,
          "isolation_failed",
          "ENV13",
          "foreign-sentinel-changed",
        );
        return {
          id: after.Id,
          startedAt: after.State.StartedAt,
          running: after.State.Running,
          owner: env.ownership.owner,
        };
      },
      close: () => env.stop(),
    };
  } catch (error) {
    await env.stop();
    throw error;
  }
}
