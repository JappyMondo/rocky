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

Two modes:

1. **API providers**: OpenAI, Anthropic (Claude), Ollama, OpenRouter, etc.
2. **CLI harnesses**: Claude Code, opencode, Codex CLI, etc. via `-p` — lets users bring their subscriptions. We only wrap the official CLIs (a harness for the harness, like T3Code); no token extraction.

## Hosting

As simple as possible: run directly as a pipeline step, or as a single small Docker container.

## Project management

Tickets live in Linear (niotix grid team). All tickets get the label `agent-rocky-reviewer` so Cyrus can map them to this repo.
