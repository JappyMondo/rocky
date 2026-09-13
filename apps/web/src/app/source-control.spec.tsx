import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { SourceControlSettings } from '@rocky/local-contracts';
import { SourceControlFields } from './source-control.js';

afterEach(cleanup);
function Editor({ profile = false }: { profile?: boolean }) {
  const [value, setValue] = useState<SourceControlSettings>({});
  return (
    <>
      <SourceControlFields
        value={value}
        onChange={setValue}
        profile={profile}
        profileId={profile ? 'bot' : undefined}
      />
      <output aria-label="Saved values">{JSON.stringify(value)}</output>
    </>
  );
}
const choose = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

it('edits SSH agent, signing and CLI references with explicit boolean choices', () => {
  render(<Editor />);
  choose('SSH agent socket', 'custom');
  choose('SSH agent socket value', '~/.bitwarden-ssh-agent.sock');
  choose('Signing format', 'custom');
  choose('Signing format value', 'ssh');
  choose('Sign commits', 'true');
  choose('Sign tags', 'false');
  choose('GitHub CLI configuration directory', 'custom');
  choose('GitHub CLI configuration directory value', '~/.rocky/gh');
  choose('GitLab token variable', 'custom');
  choose('GitLab token variable value', 'BOT_TOKEN');
  expect(
    JSON.parse(screen.getByLabelText('Saved values').textContent ?? ''),
  ).toEqual({
    git: {
      sshAgent: '~/.bitwarden-ssh-agent.sock',
      signingFormat: 'ssh',
      signCommits: true,
      signTags: false,
    },
    github: { configDir: '~/.rocky/gh' },
    gitlab: { tokenEnv: 'BOT_TOKEN' },
  });
  expect(screen.getByText('rocky exec -- gh auth login')).toBeTruthy();
});

it('distinguishes profile inheritance, an explicit value, and bypassing a Rocky default', () => {
  render(<Editor profile />);
  choose('SSH key file', 'custom');
  choose('SSH key file value', '~/.ssh/bot.pub');
  choose('SSH key file', 'system');
  expect(screen.queryByLabelText('SSH key file value')).toBeNull();
  expect(screen.getByLabelText('Saved values').textContent).toBe(
    '{"git":{"sshKey":null}}',
  );
  choose('SSH key file', 'inherit');
  expect(screen.getByLabelText('Saved values').textContent).toBe('{"git":{}}');
  choose('Sign commits', 'system');
  expect(screen.getByLabelText('Saved values').textContent).toContain(
    '"signCommits":null',
  );
  expect(
    screen.getByText('rocky exec --profile bot -- gh auth login'),
  ).toBeTruthy();
});

it('disables changes during version mismatch', () => {
  render(<SourceControlFields disabled onChange={() => undefined} />);
  expect(
    screen.getByLabelText('SSH key file').closest('fieldset')?.disabled,
  ).toBe(true);
});
