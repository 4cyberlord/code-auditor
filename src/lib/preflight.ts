/**
 * What will go wrong before it goes wrong.
 *
 * Every failure this catches is one the app already had enough information to
 * predict: a screenshot handed to models that cannot see, or a vision pass
 * pointed at models the key cannot reach. Reporting them afterwards, as four
 * identical 403s, makes the person reverse-engineer their own configuration from
 * vendor error text. Reporting them beforehand costs one line above the button.
 *
 * Pure and separately tested, because the interesting part is the *combination*
 * of settings, and combinations are where reasoning about it by eye fails.
 */

import { ALL_AGENTS, agentSpec, type AgentId } from "./models.ts";

export interface PreflightInput {
  imageCount: number;
  contextMode: "auto" | "images" | "extract" | "both";
  enabled: Record<AgentId, boolean>;
  /** Panes that currently have somewhere to send a request. */
  reachable: AgentId[];
  /** The two chosen screenshot readers. */
  extractors: AgentId[];
  /** The smallest scale among the loaded images, 1 when none were shrunk. */
  smallestScale?: number;
  /**
   * Measured vision, per agent, where the probe has actually sent a picture down
   * the route this run will use. Overrides the declared capability, because the
   * declared capability is a table and the measurement is evidence. Absent
   * entries fall back to the table.
   */
  sees?: Partial<Record<AgentId, boolean>>;
}

export interface Preflight {
  /** Set when the run cannot produce anything useful as configured. */
  blocking: string | null;
  /** Set when the run will work but not the way it looks like it will. */
  caution: string | null;
}

const list = (ids: AgentId[]) => ids.map((i) => agentSpec(i).label).join(" and ");

const SHRUNK =
  "That screenshot was shrunk to under half size to fit what vision models accept, so small text in it may not be readable. Capturing just the region you care about with ⌃⌥R keeps it full size.";

const shrunkCaution = (shrunk: boolean) => (shrunk ? SHRUNK : null);

export function preflight(input: PreflightInput): Preflight {
  const { imageCount, contextMode, enabled, reachable, extractors } = input;

  const on = ALL_AGENTS.filter((a) => enabled[a]);
  const live = on.filter((a) => reachable.includes(a));

  if (!live.length) {
    return {
      blocking: on.length
        ? "None of the models you have switched on can be reached. Add a key in Settings."
        : "Every pane is switched off.",
      caution: null,
    };
  }

  // A typed question needs nothing special: every model can read text.
  if (imageCount === 0) return { blocking: null, caution: null };

  // Worth saying before the run rather than after a confidently wrong answer:
  // a whole-screen grab shrinks code past the point of being readable.
  const shrunk = (input.smallestScale ?? 1) < 0.5;

  const canSee = (a: AgentId) => input.sees?.[a] ?? agentSpec(a).vision;
  const blind = live.filter((a) => !canSee(a));
  const seeing = live.filter((a) => canSee(a));

  // The extract path cannot tolerate a single reachable reader and still call
  // itself cross-checked: one reading over a screenshot is one place a misread
  // character can propagate to everyone downstream. Blocking on zero, warning
  // on one, silent on two.
  if (contextMode === "extract") {
    const readers = extractors.filter((e) => reachable.includes(e));
    if (!readers.length) {
      return {
        blocking:
          `The screenshot has to be transcribed first, and neither reader (${list(extractors)}) can be reached with the keys you have. ` +
          `Pick readers your key covers under Settings → Reading, or type the problem as text — the models you have switched on can all read text.`,
        caution: null,
      };
    }
    if (shrunk) return { blocking: null, caution: SHRUNK };
    if (readers.length === 1) {
      return {
        blocking: null,
        caution: `Only ${list(readers)} can be reached, so its reading of the screenshot will not be cross-checked by a second model.`,
      };
    }
    return { blocking: null, caution: null };
  }

  if (contextMode === "auto") {
    // Auto only needs a reader when a text-only pane is switched on, and even
    // then the seeing panes still answer. So the worst case is a caution.
    if (!blind.length) return { blocking: null, caution: shrunkCaution(shrunk) };
    const readers = extractors.filter((e) => reachable.includes(e));
    if (readers.length === 1) {
      // One unchecked reading reaching a blind pane is still a working run —
      // that pane answers from it — but it is worth saying out loud, because
      // the pane's FINAL can be confidently wrong in exactly the way OCR
      // misreads code.
      return {
        blocking: null,
        caution: `${list(blind)} cannot read images and only ${list(readers)} can — one reading of the screenshot, not cross-checked. If it misreads, ${blind.length === 1 ? "that pane" : "those panes"} answer with the misreading as fact.`,
      };
    }
    if (readers.length) return { blocking: null, caution: null };
    if (seeing.length) {
      return {
        blocking: null,
        caution: `${list(blind)} cannot read images and no reader is reachable, so ${blind.length === 1 ? "it" : "they"} will answer from your note alone. ${list(seeing)} still ${seeing.length === 1 ? "sees" : "see"} the screenshot.`,
      };
    }
    return {
      blocking: `${list(blind)} cannot read images, and no reader is reachable to transcribe the screenshot. Type the problem as text instead — every model you have switched on can read text.`,
      caution: null,
    };
  }

  if (contextMode === "images") {
    if (!seeing.length) {
      return {
        blocking: `${list(blind)} cannot read images, and nothing else is switched on. Set Context to "Reading" so a vision model transcribes the screenshot first — or type the problem instead of capturing it.`,
        caution: null,
      };
    }
    if (blind.length) {
      return {
        blocking: null,
        caution: `${list(blind)} cannot read images and will only see your note. Set Context to "Reading" to give them the screenshot as text.`,
      };
    }
    return { blocking: null, caution: shrunkCaution(shrunk) };
  }

  // "both" is handled above with extract; reaching here means "images", whose
  // branches returned already, or a value the type system should have refused.
  return { blocking: null, caution: shrunkCaution(shrunk) };
}

/**
 * What a run will cost against the gateway's request budget.
 *
 * The gateway counts requests per minute, and a panel is by definition a burst
 * of them: six panes, a reader and a judge is eight requests in one press. The
 * governor in Rust makes that legal by queueing, so nothing fails — but nothing
 * failing and nothing happening look identical from the outside, and a user
 * watching six panes sit at "queued" for two minutes has no way to tell a slow
 * run from a hung one.
 *
 * So it is said before the press rather than discovered during it, with the two
 * things that actually shorten it: fewer panes, or a bigger budget.
 */
export function pace(requests: number, perMinute: number): string | null {
  const budget = Math.max(1, Math.floor(perMinute));
  if (requests <= budget) return null;

  // The first `budget` requests go immediately; each further batch waits out a
  // window. Rounded to the nearest half minute, because a number to the second
  // would be false precision — models take as long as they take.
  const windows = Math.ceil(requests / budget) - 1;
  const wait =
    windows === 1 ? "about a minute" : `about ${windows} minutes`;

  return (
    `This run is ${requests} requests and your gateway allows ${budget} a minute, ` +
    `so the last panes will start ${wait} after the first. Nothing will fail — they ` +
    `queue rather than error — but to make it quick, switch some panes off or raise ` +
    `the limit in Settings → Limits if your plan is higher than ${budget}.`
  );
}

/**
 * How many gateway requests a run will make.
 *
 * Counted rather than guessed, because the interesting cases are the ones where
 * it is not obvious: a pane with its own vendor key does not spend the budget, a
 * reader does only when a picture is loaded, and the judge only when it is set
 * to run on its own.
 */
export function gatewayRequests(input: {
  panesOnGateway: number;
  readersOnGateway: number;
  hasImages: boolean;
  contextMode: "auto" | "images" | "extract" | "both";
  autoJudge: boolean;
  judgeOnGateway: boolean;
  /** The transcriber is available (on-device Apple Vision), so transcription costs nothing here. */
  ocr?: boolean;
  /** At least one pane cannot be shown the picture, so the text needs reading. */
  anyBlind?: boolean;
}): number {
  let reading = 0;
  if (input.hasImages && input.contextMode !== "images") {
    // With a transcriber, the picture never goes to a model at all. What may
    // still cost a request is *interpreting* the transcription -- and only when
    // a pane exists that cannot be shown the picture and therefore needs it.
    // When every pane can see, the transcription is written to disk and read by
    // nobody, which is free.
    if (input.ocr) reading = input.anyBlind ? Math.min(1, input.readersOnGateway) : 0;
    else reading = input.readersOnGateway;
  }
  const judge = input.autoJudge && input.judgeOnGateway ? 1 : 0;
  return input.panesOnGateway + reading + judge;
}
