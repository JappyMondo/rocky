# Source control accounts

Rocky can use its own Git SSH key, SSH agent, signing key, and GitHub/GitLab CLI
accounts. Set defaults in **Settings → Source control**, then override individual
fields in **Profiles → Source control**. The same `sourceControl` object is
available in `~/.rocky/config.json` and `~/.rocky/profiles/<id>.json`.

An omitted field inherits the Rocky default. In a profile, `null` cancels that
Rocky override and uses the existing environment/Git/CLI setting. `{}` restores
inheritance for a whole section. `false` explicitly disables signing. With no
source control configuration, existing credentials continue to work; commit
authorship still defaults to `config.identity` (Rocky / rocky@localhost).

Resolved choices are frozen at admission, before cloning, and apply to every
repository in that profile. Existing runs and step retries keep their choices.
Credential values are resolved at execution, so tokens can rotate. These settings
do not edit your global Git config, SSH config, active CLI accounts, or the
configuration of a shared bare clone. Git identity/signing settings are written
to each run's worktree and passed to child commands through their environment.

## SSH and Bitwarden

Example `config.json` fragment (merge with your existing configuration):

```json
{
  "sourceControl": {
    "git": {
      "name": "Rocky Bot",
      "email": "rocky@example.com",
      "sshKey": "~/.ssh/rocky.pub",
      "sshAgent": "~/.bitwarden-ssh-agent.sock",
      "signingFormat": "ssh",
      "signingKey": "~/.ssh/rocky-signing.pub",
      "signCommits": true,
      "signTags": true
    }
  }
}
```

Enable the [Bitwarden SSH agent](https://bitwarden.com/help/ssh-agent/) and use
the socket path shown by your desktop installation. The path above is an example;
Bitwarden's installation variants can use different locations. Keep Bitwarden
running and unlocked, and approve its requests when prompted. Rocky can also use
OpenSSH, 1Password, or another agent exposing an OpenSSH-compatible socket.

`sshKey` is a private key **file path**, or the public-key file for a key held in
the selected agent. The latter keeps the private key in Bitwarden. Rocky passes
`IdentitiesOnly=yes` when selecting a key and explicitly selects the configured
agent, overriding a personal `IdentityAgent` directive. Other SSH host settings
(including aliases, proxies, known hosts, and additional configured IdentityFiles)
remain in effect. An explicit key should exist and be readable; OpenSSH may ignore
a missing key file. Rocky does not disable host-key verification.

For SSH signing, `signingKey` can be a public-key file or Git's
`key::ssh-ed25519 ...` public-key form. Authentication and signing can use different
keys in the same agent. Choosing SSH signing uses `ssh-keygen`, overriding any
personal SSH signing helper, unless `signingProgram` explicitly names another
absolute executable path. A signing key alone does not enable signing: set
`signCommits` and optionally `signTags`.

For GPG use `signingFormat: "openpgp"` and a GPG key ID in `signingKey`.
`x509` is also supported. `signingProgram` requires an explicit signing format.
Paths must be absolute or start with `~/`. Paths also support `${VAR}` expansion
from the command/daemon environment. A managed daemon can use an explicit socket
path even when its inherited `SSH_AUTH_SOCK` differs from your terminal.

## GitHub and GitLab CLI accounts

Configure dedicated CLI directories, then authenticate from a terminal:

```json
{
  "sourceControl": {
    "github": { "configDir": "~/.rocky/accounts/github" },
    "gitlab": { "configDir": "~/.rocky/accounts/gitlab" }
  }
}
```

```sh
rocky exec -- gh auth login --hostname github.com
rocky exec -- gh auth status
rocky exec -- glab auth login --hostname gitlab.com --insecure-storage
rocky exec -- glab auth status
```

`rocky exec --profile <id> -- <command> [arguments...]` uses a profile's resolved
choices; without `--profile` it uses Rocky defaults. Put `--` before the command
to keep its flags separate from Rocky's flags. It inherits terminal I/O for native
login prompts and returns the child command's exit status.

Rocky sets [GH_CONFIG_DIR](https://cli.github.com/manual/gh_help_environment) and
[GLAB_CONFIG_DIR](https://docs.gitlab.com/cli/) per process. An explicit CLI
directory or token reference removes inherited token aliases for that platform,
so a personal `GH_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`, `GITLAB_ACCESS_TOKEN`,
`OAUTH_TOKEN`, or CI job token cannot silently take priority. It also clears
ambient CLI host/repository overrides and disables glab CI auto-login.

**glab's keyring is shared by hostname.** A separate `GLAB_CONFIG_DIR` alone does
not isolate two keyring accounts on the same host. For that case, use a named
token variable below, or log into the dedicated directory with
`--insecure-storage` (plaintext credentials in that directory). Keep that directory
private. Older glab versions store tokens in configuration by default; consult
your installed `glab auth login --help` for its storage flags. Rocky does not
switch or rewrite keyring accounts. See [GitLab authentication](https://docs.gitlab.com/cli/authentication/).

Alternatively, reference your own token variable by **name**, never by value:

```json
{
  "sourceControl": {
    "github": { "tokenEnv": "ROCKY_GITHUB_TOKEN" },
    "gitlab": { "tokenEnv": "ROCKY_GITLAB_TOKEN" }
  }
}
```

Make these values available in the daemon's environment, or in the appropriate
`credentials.json` `repos.<repository-name>` map. An explicit token reference
grants that named value to the run and takes precedence over a CLI directory.
A missing named token fails with an actionable error; it does not fall back to a
personal account. Changing an environment variable in a shell does not update an
already-running daemon's environment. Credential-file changes need no restart.

Built-in PR/MR operations use the same resolved credentials: the selected token,
or `gh auth token --hostname github.com` / `glab config get token --host gitlab.com`
in the selected environment. glab first makes a read-only `api user` call so its
native OAuth refresh can run. CLI lookup requires an explicit CLI choice in source
control settings; unconfigured profiles keep the existing secretEnv token grant
behavior. CLI lookup output stays in memory and is not written
to snapshots or logs. Rocky's built-in SCM adapters currently target github.com
and gitlab.com; selecting another CLI account does not add self-hosted SCM support.
For HTTPS Git remotes, configure a compatible credential helper in your Git
configuration (such as the native gh/glab helper); CLI account selection alone does
not install a Git credential helper.

## Per-profile example

Inside `profiles/work.json`:

```json
{
  "sourceControl": {
    "git": {
      "sshKey": "~/.ssh/work-rocky.pub",
      "signingKey": "~/.ssh/work-signing.pub",
      "email": "rocky@work.example"
    },
    "github": {
      "configDir": "~/.rocky/accounts/work-github",
      "tokenEnv": null
    }
  }
}
```

This inherits the agent socket and signing format/enablement from Rocky defaults,
selects different authentication/signing keys, and uses the work GitHub CLI store
instead of any Rocky-wide token reference. Authenticate with
`rocky exec --profile work -- gh auth login --hostname github.com`.

Existing Runs refresh source-control settings from the current instance settings
and their local profile at each Boot, including retries. This covers agent and
shell Git identity, signing, SSH and SCM authentication. Workflow code, model
choices, prompts, repository membership and recorded results remain snapshotted.
Workspace creation and retry recovery use the same current connection settings.
If a local profile was removed, its recorded connection overrides remain available
for older/imported Runs. Updating identity does not rewrite commits already made;
those unpublished commits still need an explicit repair before pushing.
