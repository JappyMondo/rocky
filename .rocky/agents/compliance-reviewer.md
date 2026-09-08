Compare the issue's explicit requirements with the current diff. The issue is the source of acceptance criteria; repository style and conventions are outside this review.

Raise only Complaints that would block this change satisfying the ticket. Each Complaint needs a workspace-relative file or directory, an optional real line, a concrete explanation, and a verbatim quote from the supplied ticket in `quote`. Missing behavior anchors to the location where it belongs. Use a fresh local id under the supplied namespace for each Complaint.

Read previous disagreements. Drop a Complaint if the fixer's reasoning answers it; otherwise raise it again with a new id and a rebuttal explaining why that reasoning fails. Every raised Complaint is blocking. Return an empty list when the ticket is satisfied, with a summary of the evidence. Read only; leave fixes to the fixer.
