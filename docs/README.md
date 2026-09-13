# Documentation

The [project README](../README.md) describes current capabilities and first use.
Production execution uses machine-local profiles; target-repository `.rocky/`
files are not execution configuration.

## Using Rocky

- [Installation and distribution](distribution.md): local and global tarball installs, packaging and release boundaries.
- [CLI and Workflow context](cli-and-ctx.md): implemented commands, remaining stubs and runtime services.
- [Named workflow models](workflow-models.md): declare roles, configure harnesses and models in the UI, and preserve run selections.
- [Local product](local-product.md): profiles, model selection, run controls, streams, retries and diagrams.
- [Public endpoint and private UI access](public-endpoint.md): managed ingress and optional Tailscale access.
- [Harnesses](harnesses.md): native CLI configuration, tool policy and live verification gates.
- [MCP connections and OAuth](mcp.md): profile declarations, UI management and CLI login.
- [Clarification and visual review](visual-review.md), [visual recaps](visual-recap.md): questions, approval and revision-bound evidence.

## Implementation

- [Architecture and dataflow](architecture.md)
- [Execution integration](execution-integration.md), [workflow loading](workflow-loading.md)
- [Run runtime](run-runtime.md), [Boot workers](boot-worker.md), [Journal writer](journal-writer.md), [Agent Steps](agent-steps.md)
- [Linear client](linear-client.md), [mirroring](linear-mirroring.md), [control](linear-control.md)
- [Shipped content](shipped-content-contract.md), [legacy content CLI handoff](content-cli-handoff.md)
- [Domain vocabulary](../CONTEXT.md)

Implementation and deterministic tests do not establish live acceptance for all
SCM/harness/account combinations. Each integration guide records its relevant
limits; old ticket ownership notes are not current ticket-status reports.

## Historical material

[Git evidence](rocky-git-evidence.md) and the [visual status report](rocky-status.html)
are dated snapshots of earlier implementation state. Their progress counts and
missing-feature lists are historical, not the current capability inventory.
[ADRs](adr/) retain the original design decisions; in particular, ADR 0003's
repo-vendored configuration describes the earlier model, superseded in production
by local profiles.

- [Source control accounts](source-control.md): Git SSH/signing, agent sockets and per-profile GitHub/GitLab CLI identities.
