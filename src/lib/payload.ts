/**
 * What each individual pane is given.
 *
 * The panel used to hand every agent an identical payload, which forced one
 * choice for everybody: either all of them read the picture, or none of them
 * did. That was fine when all four could see. It stopped being fine the moment
 * text-only models joined, because the same screenshot is simultaneously the
 * right thing to send Claude and useless to send Qwen.
 *
 * So the decision moves per pane. A model that can see gets the image and does
 * its own reading -- which is what keeps one model's misreading from becoming
 * everyone's. A model that cannot gets the transcription instead, if there is
 * one, and otherwise gets told plainly that it is working from the note alone
 * rather than being handed an empty question and left to invent something.
 */

export type ContextMode = "auto" | "images" | "extract" | "both";

export interface PayloadPlan {
  /** Whether this pane receives the raw screenshots. */
  sendImages: boolean;
  /** The transcription this pane should reason over, if any. */
  context: string;
  /** True when the pane has neither the picture nor a reading of it. */
  blind: boolean;
}

export interface PlanInput {
  mode: ContextMode;
  /** Whether this particular model can read an image. */
  canSee: boolean;
  hasImages: boolean;
  /** The cross-checked reading, empty when the vision pass did not run. */
  context: string;
}

/**
 * Decides what one pane gets.
 *
 * "auto" is the interesting one and the default: it asks the model rather than
 * the setting, so a mixed panel needs no configuration at all. The other three
 * remain as explicit overrides for when you want every pane treated alike --
 * comparing how the same model does with a picture versus a transcription, for
 * instance, is only meaningful if you can force both.
 */
export function planFor({ mode, canSee, hasImages, context }: PlanInput): PayloadPlan {
  if (!hasImages) {
    // A typed question. Nothing to see, nothing to transcribe.
    return { sendImages: false, context: "", blind: false };
  }

  switch (mode) {
    case "images":
      // Everyone gets the picture, whether or not they can use it. A model that
      // cannot see still gets the note, and is marked blind so the caller can
      // say so rather than pretending the answer was well-founded.
      return { sendImages: true, context: "", blind: !canSee };

    case "extract":
      // Nobody gets the picture. If the vision pass produced nothing, falling
      // back to images is better than sending an empty question -- but only to
      // the models that can actually use them.
      if (context) return { sendImages: false, context, blind: false };
      return { sendImages: canSee, context: "", blind: !canSee };

    case "both":
      return { sendImages: canSee, context, blind: !canSee && !context };

    case "auto":
    default:
      // Each pane gets exactly what it can use, and nothing it cannot.
      //
      // This rule has now been round-tripped, and the reason is worth keeping.
      // It was originally "seeing models read the picture, blind ones take the
      // transcription", which broke on a fact the capability table could not
      // express: a model that can see is not the same as a *route* that carries
      // a picture, and two routes here drop the image and the connection with
      // it. Everything then got the transcription, to stop panes failing.
      //
      // Two things changed since. `canSee` is now measured by the vision probe
      // rather than read off a table, so a route that drops images is known to
      // drop them. And the transcription is no longer a vision model's reading
      // of the picture -- it is an OCR engine's, which every pane can be handed
      // cheaply. So a seeing pane can go back to reading for itself, which is
      // the stronger arrangement: its eyes are independent of the transcriber's,
      // and a transcription error shows up as disagreement in the panel instead
      // of as unanimous confidence in the wrong answer.
      if (canSee) return { sendImages: true, context: "", blind: false };
      return { sendImages: false, context, blind: !context };
  }
}

/**
 * Whether a run in this mode needs the vision pass at all.
 *
 * "auto" used to be demand-driven -- two extra calls only when somebody in the
 * panel could not see. That was the cheapest correct answer while the panel was
 * four vision models, and it stopped being correct once a *route* could fail to
 * carry an image while the model behind it saw perfectly well. Under the old
 * rule nobody looked blind, no reading was made, and the panes on those routes
 * simply failed.
 *
 * So a picture now always earns a reading. It costs two calls, and it buys the
 * guarantee that every pane has something it can work from. `anyBlindPane` is
 * kept in the signature because the caller has it and the other modes may want
 * it again; "images" is still the way to opt out entirely.
 */
export function needsExtraction(
  mode: ContextMode,
  hasImages: boolean,
  anyBlindPane: boolean
): boolean {
  void anyBlindPane;
  if (!hasImages) return false;
  if (mode === "images") return false;
  return true;
}
