# agent-rocky-reviewer

Agent Rocky 🦝 — an AI code reviewer for GitHub and GitLab. Rocky the raccoon is the mascot and the actual reviewer.

## What it does

- Auto-triggered review on every change to a PR / MR.
- On first install, auto-detects review rules from the repo structure and commit history.
- Rules improve with every piece of review feedback (comments, replies, 👍 / 👎).
- Shows up as a pipeline/check in the GitHub / GitLab UI (like a Vercel deploy check).

## Web UI

- Active reviews, review history, and learnings (how each piece of feedback shaped the rules).
- Add / remove repos.
- Multi-user, sign-in via GitHub or GitLab OAuth.
- System prompt, rules, etc. fully configurable.

## AI providers

Two CLI harnesses, and nothing else:

1. **Claude Code CLI** — lets users bring their Claude subscription.
2. **opencode CLI** — reaches any OpenAI-compatible endpoint (OpenAI, OpenRouter, Ollama, self-hosted) by pointing it at a custom base URL.

Both browse the checkout themselves, which is what makes reviews worth reading. We only wrap the official CLIs (a harness for the harness, like T3Code); no token extraction, and no hand-rolled agent loop over a raw chat-completions API.

## Hosting

As simple as possible: run directly as a pipeline step, or as a single small Docker container.

## Development

Nx workspace, pnpm, Node current LTS (see `.nvmrc`). Two apps: `server` (NestJS on
the Fastify adapter) and `web` (React SPA built by Vite). The review core will
live as a directory inside `server`, not as a separate package.

```sh
pnpm install
pnpm exec nx serve web        # Vite dev server on :4200
pnpm exec nx serve server     # API on ROCKY_PORT
pnpm exec nx build server     # server bundle with the built SPA in dist/public
pnpm exec nx run-many -t build typecheck lint test
```

`nx build server` builds `web` first and copies its output into
`apps/server/dist/public`, which the server serves as static files. Deep links
fall back to `index.html`; anything under `/api` keeps its own 404.

Auto-generated OpenAPI docs and Swagger UI are served at `/api/docs`, publicly
and unauthenticated.

## Deploy config

Four environment variables, read and validated once at boot. There is no config
file and no fifth variable — everything else is an Instance setting held in the
database and edited in the web UI.

| Var                    | Required | Default |
| ---------------------- | -------- | ------- |
| `ROCKY_ENCRYPTION_KEY` | yes      | —       |
| `ROCKY_BASE_URL`       | yes      | —       |
| `ROCKY_PORT`           | no       | `3000`  |
| `ROCKY_LOG_LEVEL`      | no       | `info`  |

Rocky refuses to start when a required variable is missing, and prints a freshly
generated key when `ROCKY_ENCRYPTION_KEY` is absent. It never writes that key
into `/data`: the key and the database must not end up in the same backup
tarball. The data volume path is fixed at `/data` and is not configurable.

`ROCKY_BASE_URL` is the single source for every absolute URL Rocky generates —
webhook targets, OAuth redirects and Public report links. Nothing reads `Host`
or `X-Forwarded-*`, because behind a reverse proxy those are a guess.

## Project management

Tickets live in Linear (niotix grid team). All tickets get the label `agent-rocky-reviewer` so Cyrus can map them to this repo.
