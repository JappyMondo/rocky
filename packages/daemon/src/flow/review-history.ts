import type { Complaint, Resolution } from './schemas.js';

export const reviewPolicy = {
  instructions:
    'Use this review protocol when older prompt text conflicts with it. For compliance-reviewer and reviewer: report ALL issues found in one comprehensive pass; there is no one-issue limit. Categorize each new issue as nit-pick, should-fix or must-fix. Nit picks are cosmetic preferences and must never block or go to a fixer. Should-fix issues are concrete noncritical defects; must-fix issues are correctness, data-loss, security or acceptance failures. Verify every non-ignored previous issue and return its history id, status (fixed, open or dismissed), and evidence in previousIssues. Fixer claims are not proof. The compliance reviewer has bash to independently run targeted verification commands when acceptance evidence is missing; keep repository source unchanged and record the command, result, and inspected artifact in the assessment. Do not leave an issue open solely because the fixer did not supply independently inspectable command output when you can perform the check. Do not mint a new complaint for an existing issue: keep it in previousIssues. After your first review, discover new issues only in the supplied incremental diff and behavior affected by those commits. Read unchanged code only as context or to verify known issues; do not restart a full review of unchanged commits. A previously verified issue may reopen only when the new changes regress it. Other review agents use the history within their assigned scope and output schema. Fixers receive all prior issues and resolutions as context, but act only on the supplied active complaints; do not reverse a prior fix without explaining the conflict.',
};

export interface PreviousIssueAssessment {
  id: string;
  status: 'fixed' | 'open' | 'dismissed';
  note: string;
}

interface HistoricalIssue {
  id: string;
  source: string;
  head?: string;
  complaint: Complaint;
  status:
    'open' | 'fix-reported' | 'disagreed' | 'fixed' | 'dismissed' | 'ignored';
  resolutions: Resolution[];
  verifications: PreviousIssueAssessment[];
}

/** Rebuilt from journaled agent results on every Boot, including old batches. */
export class ReviewHistory {
  private issues: HistoricalIssue[] = [];

  snapshot() {
    return structuredClone(this.issues);
  }

  private find(id: string) {
    return (
      this.issues.find((issue) => issue.id === id) ??
      this.issues.findLast((issue) => issue.complaint.id === id)
    );
  }

  add(complaints: readonly Complaint[], source: string, head?: string) {
    for (const complaint of complaints) {
      this.issues.push({
        id: `issue-${this.issues.length + 1}`,
        source,
        ...(head ? { head } : {}),
        complaint: { ...complaint, severity: complaint.severity ?? 'must-fix' },
        status: complaint.severity === 'nit-pick' ? 'ignored' : 'open',
        resolutions: [],
        verifications: [],
      });
    }
  }

  forFixer(complaints: readonly Complaint[], source: string) {
    const active = complaints.filter(
      (complaint) => complaint.severity !== 'nit-pick',
    );
    for (const complaint of active) {
      const known = this.find(complaint.id);
      if (
        !known ||
        known.complaint.text !== complaint.text ||
        known.complaint.file !== complaint.file
      )
        this.add([complaint], source);
    }
    return active;
  }

  resolved(resolutions: readonly Resolution[]) {
    for (const resolution of resolutions) {
      const issue = this.find(resolution.id);
      if (!issue) continue;
      issue.resolutions.push(structuredClone(resolution));
      issue.status =
        resolution.status === 'fixed' ? 'fix-reported' : 'disagreed';
    }
  }

  review(
    result: {
      complaints: Complaint[];
      previousIssues?: PreviousIssueAssessment[];
    },
    source: string,
    head: string,
  ) {
    const stillOpen: Complaint[] = [];
    for (const assessment of result.previousIssues ?? []) {
      const issue = this.issues.find((issue) => issue.id === assessment.id);
      if (!issue || issue.status === 'ignored') continue;
      issue.verifications.push(structuredClone(assessment));
      issue.status = assessment.status;
      if (assessment.status === 'open')
        stillOpen.push({
          ...issue.complaint,
          id: issue.id,
          rebuttal: assessment.note,
        });
    }
    this.add(result.complaints, source, head);
    return [
      ...stillOpen,
      ...result.complaints.filter(
        (complaint) => complaint.severity !== 'nit-pick',
      ),
    ];
  }
}
