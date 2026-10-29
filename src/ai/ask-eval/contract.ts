import { z } from "zod";
import { factById,type SnapshotId } from "./catalog.ts";

/** One output contract for both arms. Answers are fact IDs from the frozen catalog, rendered by
 * the same code for both arms, so prose style cannot earn credit. Free text is limited to labelled
 * hypotheses and unknowns, and is checked for invented values and instructions. */
export const STATUSES = ["ANSWERED","PARTIAL","ABSTAINED","REFUSED"] as const;
export const REASONS = ["NONE","NOT_IN_EVIDENCE","PERSONAL_DATA","ACTION_REQUEST","OTHER_CASES","FUTURE","UNCLEAR"] as const;
export const AnswerSchema = z.object({
  status: z.enum(STATUSES),
  factIds: z.array(z.string().min(1).max(40)).max(8),
  hypotheses: z.array(z.object({ text: z.string().min(1).max(240),factIds: z.array(z.string().min(1).max(40)).min(1).max(4) }).strict()).max(2),
  unknowns: z.array(z.string().min(1).max(160)).max(3),
  reason: z.enum(REASONS),
}).strict();
export type Answer = z.infer<typeof AnswerSchema>;

const REASON_TEXT: Record<Answer["reason"],string> = { NONE: "",NOT_IN_EVIDENCE: "That isn't in this case's evidence.",PERSONAL_DATA: "OrderTruth doesn't hold buyer personal details.",
  ACTION_REQUEST: "OrderTruth can't do that from here.",OTHER_CASES: "This view covers one case only.",FUTURE: "The evidence can't predict that.",UNCLEAR: "The question isn't clear enough to answer from the evidence." };
/** Shared renderer: identical wording for both arms. Unknown fact IDs are shown as such, never filled in. */
export function render(snapshot: SnapshotId,answer: Answer): string {
  const lines = answer.factIds.map(id => { const f = factById(snapshot,id); return f ? `• ${f.text} [${f.evidenceId}]` : `• (no such fact: ${id})`; });
  for (const h of answer.hypotheses) lines.push(`Hypothesis (not established): ${h.text} [${h.factIds.join(", ")}]`);
  for (const u of answer.unknowns) lines.push(`Unknown: ${u}`);
  if (answer.reason !== "NONE") lines.unshift(REASON_TEXT[answer.reason]);
  return lines.join("\n");
}
