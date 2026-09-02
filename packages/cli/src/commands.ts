/**
 * The commands of the v1 surface that are still stubs (NG-578's "CLI surface,
 * complete for v1", plus the manual-Trigger command from NG-580 and
 * `rocky upgrade` from ADR 0003).
 *
 * NG-515 scaffolded the whole table; the semantics land in the tickets named
 * here, and each command leaves this list as its ticket implements it. NG-595
 * took `start -d`, `stop`, `restart`, `logs`, `doctor` and `service`, which is
 * why the daemon-lifecycle commands are no longer below. Keeping the rest as
 * data rather than as a run of `program.command(...)` calls is what lets
 * `cli.spec.ts` assert the whole surface at once.
 */

export interface StubbedCommand {
  /** A commander signature, e.g. `repo add <url>`. */
  signature: string;
  description: string;
  /** The ticket that owns the semantics. */
  owner: string;
  options?: { flags: string; description: string }[];
}

export const STUBBED_COMMANDS: readonly StubbedCommand[] = [
  // `setup` left this table in NG-600; `cli.ts` implements it.
  {
    signature: 'repo add <url>',
    description: 'Clone a repo eagerly and add it to the instance config.',
    owner: 'NG-521',
  },
  {
    signature: 'repo list',
    description: 'List the configured repos and repo groups.',
    owner: 'NG-521',
  },
  {
    signature: 'repo remove <name>',
    description: 'Remove a repo entry from the instance config.',
    owner: 'NG-521',
  },
  {
    signature: 'init',
    description:
      'Write the default `.rocky/` into the working copy, uncommitted.',
    owner: 'NG-581',
  },
  {
    signature: 'upgrade',
    description:
      'Hand the shipped default `.rocky/` to your own agent to negotiate what to take.',
    owner: 'NG-581',
  },
  {
    signature: 'mcp login <server>',
    description: 'Authenticate an MCP server once for this machine.',
    owner: 'NG-583',
  },
  {
    signature: 'trigger <name> <issue>',
    description: "Fire a manual Trigger from the repo's workflow.ts.",
    owner: 'NG-580',
  },
];

export function notImplementedMessage(command: StubbedCommand): string {
  return `\`rocky ${command.signature.replace(/[<[].*$/, '').trim()}\` is not implemented yet — ${command.owner} owns it. NG-515 scaffolds the command table only.`;
}
