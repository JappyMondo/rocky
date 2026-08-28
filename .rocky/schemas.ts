/**
 * PROTOTYPE (NG-572) — the Agent output contracts, as repo-owned zod schemas.
 *
 * The contested decision this file embodies: schemas live in TypeScript next
 * to the workflow, NOT in the Agent markdown frontmatter. The workflow gets
 * the type by importing the same value the runner validates with — no
 * codegen, no drift. The markdown files stay prose. (The map's original
 * Agent definition said "output schema in the markdown file"; this prototype
 * proposes amending that.)
 *
 * The exact Complaint/Plan shapes are NG-575's to settle; these are minimal
 * placeholders good enough to type the default Workflow.
 */
import { z } from "@rocky/sdk";

export const Complaint = z.object({
  file: z.string().optional(),
  line: z.number().optional(),
  text: z.string(),
});
export type Complaint = z.infer<typeof Complaint>;

export const Plan = z.object({
  summary: z.string(),
  steps: z.array(z.string()),
  /** The planner declares it; the workflow's UI stage is a plain `if`. */
  touchesUi: z.boolean(),
});
export type Plan = z.infer<typeof Plan>;

/** What every reviewing Agent (compliance, UI, code) returns. */
export const Review = z.object({
  complaints: z.array(Complaint),
});

/** What every fixing Agent returns. */
export const FixReport = z.object({
  fixed: z.array(z.string()),
  /** Disagreements go back to the reviewer; if it insists, they burn the cap. */
  disagreed: z.array(z.object({ complaint: z.string(), why: z.string() })),
});
export type FixReport = z.infer<typeof FixReport>;

/** Working Agents (implementer, merger) just report what they did. */
export const WorkReport = z.object({
  summary: z.string(),
});
