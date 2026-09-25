# Rocky development rules

Rocky and its shipped default workflow must work out of the box with any repository that Rocky supports.

- Discover each repository's instructions, validation commands, CI checks, and contribution rules from that repository and its configured integrations at run time.
- Treat failed CI jobs and their logs as evidence. Route failures to a fixer agent, then verify the repair with the repository's actual checks.
- Fix recurring run failures in Rocky's profile, workflow, or runtime so future runs recover automatically. A single-run repair is verification of the durable fix, not the fix itself.
- Keep repository-specific policies and check names in repository configuration or instructions. Do not encode them in Rocky's generic prompts, schemas, or workflow logic.
- When changing the default workflow, test with project-neutral examples and confirm that a run can reach its CI fixer even when another review would otherwise exhaust the run.
