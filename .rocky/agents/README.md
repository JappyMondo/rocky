# Agents (PROTOTYPE, NG-572)

One markdown file per Agent: frontmatter holds model, harness and tool
policy; the body is the prompt. The **output schema is not here** — it lives
at the call site in `workflow.ts` (via `schemas.ts`), so the workflow's types
and the runner's validation come from the same value. The runner appends the
JSON schema of the call site's `schema` to the prompt automatically.

Frontmatter fields (all optional, defaults from `config.ts`):

```yaml
model: sonnet        # resolution rules are NG-579's problem
harness: claude-code
tools: read, edit, bash   # tool policy vocabulary is NG-575's problem
```
