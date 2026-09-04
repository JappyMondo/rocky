/**
 * The console prompter, driven over a pair of streams rather than a terminal.
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { createConsolePrompter } from './prompter.js';

function pair() {
  const input = new PassThrough();
  const output = new PassThrough();
  const written: string[] = [];
  output.on('data', (chunk: Buffer) => written.push(chunk.toString()));

  return {
    input,
    output,
    written: () => written.join(''),
    prompter: createConsolePrompter(input, output),
  };
}

describe('the console prompter', () => {
  it('writes a line with its own newline', () => {
    const { prompter, written, output } = pair();

    prompter.say('Rocky setup');
    prompter.close();
    output.end();

    expect(written()).toContain('Rocky setup\n');
  });

  it('asks, and hands back the answer trimmed', async () => {
    const { prompter, input, written } = pair();

    const answer = prompter.ask('Your public URL:');
    input.write('  https://rocky.example.com  \n');

    expect(await answer).toBe('https://rocky.example.com');
    expect(written()).toContain('Your public URL: ');
    prompter.close();
  });

  it('reads a secret the same way, because a hidden paste hides its own typos', async () => {
    const { prompter, input } = pair();

    const answer = prompter.askSecret('Client secret:');
    input.write('lin_oauth_secret\n');

    expect(await answer).toBe('lin_oauth_secret');
    prompter.close();
  });

  it('waits for a bare enter', async () => {
    const { prompter, input, written } = pair();

    const waited = prompter.waitFor('Press enter once the app exists.');
    input.write('\n');

    await expect(waited).resolves.toBeUndefined();
    expect(written()).toContain('Press enter once the app exists. ');
    prompter.close();
  });
});
