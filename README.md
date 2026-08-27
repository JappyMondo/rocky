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

## Project management

Tickets live in Linear (niotix grid team). All tickets get the label `agent-rocky-reviewer` so Cyrus can map them to this repo.
