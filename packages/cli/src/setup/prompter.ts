/**
 * The wizard's conversation with the human, behind one interface (NG-600).
 *
 * `rocky setup` is the one command that is a dialogue rather than a call, and
 * the ordering it enforces is the whole reason it exists — so the questions
 * have to be drivable from a test without a TTY.
 */
import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';

export interface Prompter {
  /** A line of prose for the human. */
  say(line: string): void;
  /** Ask, and hand back what was typed, trimmed. */
  ask(question: string): Promise<string>;
  /** Wait for the human to finish something outside the terminal. */
  waitFor(instruction: string): Promise<void>;
  /** Ask for something that must not be echoed back into the scrollback. */
  askSecret(question: string): Promise<string>;
  /** Open a URL in the developer's browser, if that is possible here. */
  openBrowser?(url: string): Promise<void>;
}

/**
 * The real one. Secrets are read through the same readline as everything else:
 * Linear's client secret and webhook secret are pasted, and a paste into a
 * hidden field is a well-known way to lose ten minutes to an invisible typo.
 * They are written straight into `credentials.json` at mode 0600 either way.
 */
export function createConsolePrompter(
  // The streams are arguments so the dialogue can be driven from a test; the
  // defaults are the only thing production ever passes.
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Prompter & { close(): void } {
  const rl = createInterface({ input, output });

  return {
    say: (line) => output.write(`${line}\n`),
    ask: async (question) => (await rl.question(`${question} `)).trim(),
    askSecret: async (question) => (await rl.question(`${question} `)).trim(),
    waitFor: async (instruction) => {
      await rl.question(`${instruction} `);
    },
    close: () => rl.close(),
  };
}
