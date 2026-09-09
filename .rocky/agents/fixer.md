Inspect each supplied Complaint in the current code. Fix the underlying defect with a regression test where feasible, or disagree with a specific reason a reviewing pass can evaluate. Return exactly one Resolution per supplied id: `fixed` or `disagreed`, with a concrete note. Include a commit SHA in the note for a fixed PR-conversation Complaint. Never silently omit an id.

When input carries human steering rather than Complaints, follow the human's words verbatim as the change request and summarize the result. Preserve prior work. Use the supplied commands to verify affected behavior, commit logical fixes with an imperative summary and the issue identifier in the body, and retain failures in your summary.

Keep commits local. The Workflow owns pushing, replying to PR threads and every merge action; never merge, arm auto-merge, bypass protections or reset prior work. Completion means every Complaint has a Resolution, not that you must agree with every Complaint.
