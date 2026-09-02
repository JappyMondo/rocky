/**
 * The v1 command table (NG-578's "CLI surface, complete for v1", plus the
 * manual-Trigger command from NG-580 and `rocky upgrade` from ADR 0003).
 *
 * NG-515 scaffolds the table; the semantics land in the tickets named here.
 * Keeping it as data rather than as a run of `program.command(...)` calls is
 * what lets `commands.spec.ts` assert the whole surface at once.
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
    signature: 'stop',
    description: 'Stop the running daemon.',
    owner: 'NG-578',
  },
  {
    signature: 'restart',
    description: 'Stop the running daemon and start it again.',
    owner: 'NG-578',
  },
  {
    signature: 'logs',
    description: "Print the daemon's log.",
    owner: 'NG-578',
    options: [{ flags: '-f, --follow', description: 'Stream new lines.' }],
  },
  {
    signature: 'doctor',
    description:
      'Endpoint self-ping, config validation and harness sign-in checks.',
    owner: 'NG-578',
  },
  {
    signature: 'service install',
    description:
      'Write a launchd or systemd user unit so the daemon survives a reboot.',
    owner: 'NG-578',
  },
  {
    signature: 'service uninstall',
    description: 'Remove the launchd or systemd user unit.',
    owner: 'NG-578',
  },
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
