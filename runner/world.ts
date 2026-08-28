/**
 * PROTOTYPE (NG-572) — a scripted fake world for the demo. Agent replies are
 * queues per Agent name; CI results and Checkpoint answers are queues too,
 * where an empty Checkpoint queue means "the human has not answered" and a
 * PENDING CI item means "the pipeline is still running".
 */
import { type CheckpointAnswer, type CiResult, type Pr } from "@rocky/sdk";
import { PENDING, type Pending, type World } from "./journal.ts";

export class FakeWorld implements World {
  agentCalls: Record<string, number> = {};
  posts: string[] = [];
  private agents: Record<string, unknown[]> = {};
  private ci: (CiResult | Pending)[] = [];
  private checkpointAnswers: CheckpointAnswer[] = [];

  scriptAgent(name: string, ...replies: unknown[]) {
    (this.agents[name] ??= []).push(...replies);
  }
  scriptCi(...results: (CiResult | Pending)[]) {
    this.ci.push(...results);
  }
  /** The human acts: the next (retried) checkpoint Step will consume this. */
  answerCheckpoint(answer: CheckpointAnswer) {
    this.checkpointAnswers.push(answer);
  }

  agent(name: string, _input: unknown): unknown {
    this.agentCalls[name] = (this.agentCalls[name] ?? 0) + 1;
    const reply = this.agents[name]?.shift();
    if (reply === undefined) throw new Error(`fake world: no scripted reply left for agent "${name}"`);
    return reply;
  }
  exec(cmd: string) {
    return { exitCode: 0, stdout: `$ ${cmd}`, stderr: "" };
  }
  post(markdown: string) {
    this.posts.push(markdown);
  }
  changedFiles() {
    return ["src/api.ts", "src/api.test.ts"];
  }
  openPr(opts: { title: string }): Pr {
    return { number: 7, url: "https://github.com/JappyMondo/demo/pull/7", headSha: "abc123" };
  }
  markDraft(_pr: Pr) {}
  waitForCi(_pr: Pr): CiResult | Pending {
    return this.ci.shift() ?? PENDING;
  }
  updateBranch(_pr: Pr): "updated" | "clean" | "conflict" {
    return "clean";
  }
  armAutoMerge(_pr: Pr) {}
  checkpoint(_opts: { title: string }): CheckpointAnswer | Pending {
    return this.checkpointAnswers.shift() ?? PENDING;
  }
}
