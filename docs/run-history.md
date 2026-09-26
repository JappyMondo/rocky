# Run history

The Runs page groups attempts by the integration’s stable ticket ID, falling back to the ticket URL. Runs without a ticket URL use their issue identifier within their repository and profile context. The newest attempt appears first; expand earlier attempts to see their individual outcomes and open their journals. Pagination keeps each ticket's attempts together.

The default **Unsettled** view hides runs you have marked **Settled**. Use the **Settle** button on a completed, failed, exhausted or cancelled attempt when it no longer needs attention. **Settled** shows hidden attempts and provides **Restore**; **All runs** includes both. Search and repository/status filters continue to work across ticket groups. Settled attempts are also omitted from recent runs and keyboard navigation.

Settling is reversible presentation metadata. It does not cancel work, change a recorded outcome, approve a checkpoint, delete artifacts or alter retention policy. Running, queued and waiting attempts cannot be settled. If an attempt resumes, its next outcome becomes visible again. A new attempt starts unsettled independently of its predecessors.

The private API exposes `settledAt` in run summaries and accepts `POST /api/runs/:id/settle` with `{ "settled": true }` or `{ "settled": false }`. It keeps settlement receipts separate from scheduler-owned headers and workflow journals.
