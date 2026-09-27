# Protected acceptance contract v1.0.0

Status: **pending independent review; not executed**. Taskbot ticket 9 owns this contract. Ticket 5 must wait for independent approval. The source baseline is `5bb89a7d376565749c3f2bab9b67462bcb097afc`; it identifies the concept input, not an implemented artifact.

- `requirements.json`: complete first-version requirement IDs, concept references, responsible modules/tickets, qualification level and required evidence. Concrete tickets 5-15 own implementation, integration, qualification and final review; related tickets identify later evidence responsibility.
- `foundation-scenarios.json`: eleven externally observable local foundation scenarios and fourteen later adversarial cases. These specify behavior, input data and required evidence, not private implementation details.
- `SHA256SUMS`: SHA-256 of both JSON contracts, this README and the architecture decisions. It deliberately excludes itself. Verify against the independently approved committed revision; an untrusted replacement checksum file proves nothing.

All requirement/scenario states are unverified. No acceptance tests or product code exist yet. Later test bindings must name executable commands and record per-assertion results. Fake transports and synthetic local runs are useful foundation proof, but cannot establish Attraccess setup, real harness coding, GitHub CI/protections, human approval, merge or Linear acceptance.

## Protection and change control

The orchestrator serializes repository writes with a Taskbot lease. Ticket 5's implementation owner cannot write `acceptance/contracts/`. A separate acceptance author proposes changes, explains any behavioral change, bumps the version and regenerates hashes; a different Astra/high reviewer approves them. A compiler error or inconvenient failure is not permission to weaken the contract. Evaluators compare the approved content hashes before and after an attempt and execute outside the target coding agent's writable scope. Runtime enforcement belongs in implementation; this document alone is not enforcement.

The foundation evaluator must exercise actual temporary child/worker processes for lifecycle and crash behavior, while keeping effects local. It must preserve evidence of failures and interrupted output. It must test stale owners and cancellation at the actual effect-dispatch seam, not merely display a cancelled flag.

## Benchmark boundary

B01-B10 are **UNFROZEN candidates**, not confirmed defects or eligible tasks. Ticket 6 must inspect real source, select independent bounded tasks, establish old-behavior failures and pin baseline/check/fixture/scenario/model/budget/authority identities before scored trials. Ticket 4 controls target workspace and external-effect authority. All attempts, failures and admission rejections remain visible. Reruns do not replace failed attempts; no-code outcomes do not count. At least 8 of 10 predeclared eligible coding tasks must reach verified PR handoff without operator repair, and every mandatory adversarial case must pass. Planned human merge approval is retained and excluded from intervention counts.

## Validation of this document set

Parse both JSON files, check unique requirement/scenario/slot IDs and all scenario references, require exactly ten UNFROZEN benchmark slots with null baseline/issue, verify SHA256SUMS, and inspect `git diff --check`. These checks validate the contract only. They establish no implementation or live acceptance result.
