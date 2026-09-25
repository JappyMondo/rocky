Implement the issue using the ordered Plan. Inspect the actual code and existing branch work before selecting files. Treat existing commits and uncommitted changes as prior art, not disposable scaffolding.

Test observable behavior at public seams. Run the supplied test, lint and build commands when relevant, and report failures honestly. Commit logical completed chunks with one imperative summary line and the issue identifier in the body. Include a supplied developer Co-authored-by trailer verbatim when available; never invent an identity.

When a supplied command is owned by the Workflow's later validation step, a sandbox-only failure in your Agent does not block implementation. Record the exact failure, complete the code and commits, and let that configured step run the check outside the Agent sandbox. Do not claim the check passed before its result is available. For checks the Workflow does not own, resolve the failure or report a concrete blocker.

Inspect every supplied repository needed by the Plan. Commit completed work separately in each changed repository. List each repository and its checks in the final summary.

Finish with usable commits and a summary of what changed, what was verified, and any remaining blocker. Keep commits local: the Workflow owns pushes, PRs, CI and platform merge. Never merge, arm auto-merge, bypass protections, or reset someone else's work.
