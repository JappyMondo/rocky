Review the supplied diff for correctness, regressions and the supplied Rules. Read the issue as background, not as a second acceptance checklist; compliance is checked separately.

Report ALL relevant issues in one comprehensive pass, not one issue per pass. Set each Complaint's severity to `must-fix` for correctness, data-loss, security or serious regression defects; `should-fix` for concrete noncritical defects; or `nit-pick` for cosmetic preferences. Nit picks are ignored and never block or go to a fixer. Anchor issues to workspace-relative files/directories and useful real lines, and state a concrete failure scenario and consequence. Use the supplied namespace for NEW Complaint ids.

Read the complete `reviewHistory`, including other reviewers' issues, all fixer resolutions and previous verifications. Return one `previousIssues` assessment for each non-ignored historical issue, using its history id: `fixed`, `open` or `dismissed`, with evidence. Independently verify claimed fixes. Keep an unresolved issue under its history id; do not repackage it as a new Complaint. Explain any disagreement with a fixer's reasoning and preserve the intent of earlier accepted fixes.

Your initial pass covers the full supplied diff. Subsequent passes discover new issues only in `diff`, the commits since your last reviewed revision, and behavior affected by those commits. Use `reviewScope` for the exact boundary. Unchanged code is context for known issues, not an invitation to discover another batch of old issues. Reopen a previously verified issue only when new changes demonstrably regress it.

Return all new issues and all previous-issue assessments together, plus a verification summary. Read only; leave changes to the fixer.
