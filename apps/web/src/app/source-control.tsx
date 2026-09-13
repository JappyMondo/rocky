import type { SourceControlSettings } from '@rocky/local-contracts';
import styles from './app.module.css';

type Field = {
  key: string;
  label: string;
  hint?: string;
  choices?: string[];
  boolean?: boolean;
};
const groups: Array<{
  key: keyof SourceControlSettings;
  title: string;
  description: string;
  fields: Field[];
}> = [
  {
    key: 'git',
    title: 'Git identity, SSH and signing',
    description:
      'Use a private key file, or a public key file with an SSH agent. Paths can start with ~/. Signing needs both a key and an enabled signing setting.',
    fields: [
      { key: 'name', label: 'Commit author name' },
      { key: 'email', label: 'Commit author email' },
      { key: 'sshKey', label: 'SSH key file', hint: '~/.ssh/rocky.pub' },
      {
        key: 'sshAgent',
        label: 'SSH agent socket',
        hint: '~/.bitwarden-ssh-agent.sock',
      },
      {
        key: 'signingFormat',
        label: 'Signing format',
        choices: ['ssh', 'openpgp', 'x509'],
      },
      {
        key: 'signingKey',
        label: 'Signing key',
        hint: 'Public key file, key::ssh-ed25519 …, or GPG key ID',
      },
      {
        key: 'signingProgram',
        label: 'Signing program (optional)',
        hint: '/absolute/path/to/program',
      },
      { key: 'signCommits', label: 'Sign commits', boolean: true },
      { key: 'signTags', label: 'Sign tags', boolean: true },
    ],
  },
  {
    key: 'github',
    title: 'GitHub CLI',
    description:
      'Choose a separate gh configuration directory or a token environment variable. Explicit choices take precedence over inherited tokens.',
    fields: [
      {
        key: 'configDir',
        label: 'GitHub CLI configuration directory',
        hint: '~/.rocky/accounts/github',
      },
      {
        key: 'tokenEnv',
        label: 'GitHub token variable',
        hint: 'ROCKY_GITHUB_TOKEN (variable name only)',
      },
    ],
  },
  {
    key: 'gitlab',
    title: 'GitLab CLI',
    description:
      'Choose a separate glab configuration directory or a token environment variable. For separate accounts on the same host, use a token variable or file storage; glab keyring entries are shared by host.',
    fields: [
      {
        key: 'configDir',
        label: 'GitLab CLI configuration directory',
        hint: '~/.rocky/accounts/gitlab',
      },
      {
        key: 'tokenEnv',
        label: 'GitLab token variable',
        hint: 'ROCKY_GITLAB_TOKEN (variable name only)',
      },
    ],
  },
];

export function SourceControlFields(p: {
  value?: SourceControlSettings;
  onChange(value: SourceControlSettings): void;
  profile?: boolean;
  profileId?: string;
  disabled?: boolean;
}) {
  const inherit = p.profile ? 'Use Rocky default' : 'Use existing setting';
  const scope = p.profileId ? ` --profile ${p.profileId}` : '';
  return (
    <section aria-label="Source control settings">
      <div className={styles.sectionHeading}>
        <div>
          <h2>Source control</h2>
          <p>
            {p.profile
              ? 'Override individual Rocky defaults for this profile. Changes apply to new runs.'
              : 'Defaults for all profiles. Changes apply to new runs; your personal Git and CLI configuration stays unchanged.'}
          </p>
        </div>
      </div>
      {groups.map((group) => (
        <fieldset
          key={group.key}
          disabled={p.disabled}
          className={styles.sourceControlGroup}
        >
          <legend>{group.title}</legend>
          <p>{group.description}</p>
          <div className={styles.fieldGrid}>
            {group.fields.map((field) => {
              const values = p.value?.[group.key] ?? {};
              const value = (values as Record<string, string | boolean | null>)[
                field.key
              ];
              const change = (next: string | boolean | null | undefined) => {
                const section: Record<
                  string,
                  string | boolean | null | undefined
                > = { ...values, [field.key]: next };
                if (next === undefined) delete section[field.key];
                p.onChange({ ...p.value, [group.key]: section });
              };
              const mode =
                value === undefined
                  ? 'inherit'
                  : value === null
                    ? 'system'
                    : 'custom';
              return (
                <div key={field.key} className={styles.sourceControlField}>
                  <label>
                    {field.label}
                    <select
                      value={
                        field.boolean && mode === 'custom'
                          ? String(value)
                          : mode
                      }
                      onChange={(event) => {
                        const selected = event.target.value;
                        change(
                          selected === 'inherit'
                            ? undefined
                            : selected === 'system'
                              ? null
                              : field.boolean
                                ? selected === 'true'
                                : (field.choices?.[0] ?? ''),
                        );
                      }}
                    >
                      <option value="inherit">{inherit}</option>
                      {p.profile && (
                        <option value="system">
                          Use existing setting (ignore Rocky default)
                        </option>
                      )}
                      {field.boolean ? (
                        <>
                          <option value="true">Enabled</option>
                          <option value="false">Disabled</option>
                        </>
                      ) : (
                        <option value="custom">Override</option>
                      )}
                    </select>
                  </label>
                  {!field.boolean &&
                    mode === 'custom' &&
                    (field.choices ? (
                      <select
                        aria-label={`${field.label} value`}
                        value={String(value)}
                        onChange={(event) => change(event.target.value)}
                      >
                        {field.choices.map((choice) => (
                          <option key={choice}>{choice}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        aria-label={`${field.label} value`}
                        required
                        value={String(value)}
                        placeholder={field.hint}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => change(event.target.value)}
                      />
                    ))}
                </div>
              );
            })}
          </div>
        </fieldset>
      ))}
      <p className={styles.muted}>
        Save your choices, then sign in from a terminal with{' '}
        <code>rocky exec{scope} -- gh auth login</code> or{' '}
        <code>rocky exec{scope} -- glab auth login</code>. Tokens belong in the
        CLI credential store, daemon environment or credentials.json, never in
        these fields. Bitwarden must be running and unlocked to approve agent
        requests.
      </p>
    </section>
  );
}
