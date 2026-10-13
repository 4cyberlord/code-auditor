import type { RunDetail, RunSummary } from "./sessions.ts";
import { isPlaceholder, titleFor } from "./title.ts";

interface SavedCandidate {
  letter?: string;
  final?: { answer?: string };
  revised?: { answer?: string };
}
interface SavedContract {
  signature?: string;
  inputs?: string;
  outputs?: string;
  constraints?: string;
  examples?: string;
}

function savedCouncil(detail?: RunDetail | null) {
  return detail?.report?.council as {
    winner?: string;
    candidates?: SavedCandidate[];
    contract?: SavedContract | null;
  } | undefined;
}

/** Names an individual run, including image-only runs whose typed note is empty. */
export function savedRunTitle(run: RunSummary, sessionTitle: string, detail?: RunDetail | null): string {
  const council = savedCouncil(detail);
  const winner = council?.candidates?.find(candidate => candidate.letter === council.winner);
  const answers = [winner?.revised?.answer, winner?.final?.answer,
    ...(detail?.responses ?? []).map(response => response.finalAnswer ?? "")]
    .filter((answer): answer is string => Boolean(answer?.trim()))
    .map(answer => ({ answer }));
  return titleFor({ note: run.asked, answers }) ||
    (!isPlaceholder(sessionTitle) ? sessionTitle : "Captured question");
}

/** The saved reading is the question record when no text was typed. */
export function savedRunQuestion(detail: RunDetail): string {
  if (detail.run.asked.trim()) return detail.run.asked.trim();
  const contract = savedCouncil(detail)?.contract;
  if (!contract) return "";
  return ([
    ["Task", contract.signature], ["Inputs", contract.inputs],
    ["Output", contract.outputs], ["Constraints", contract.constraints],
    ["Examples", contract.examples],
  ] as const).filter(([, value]) => value?.trim())
    .map(([label, value]) => `${label}: ${value?.trim()}`).join("\n");
}
