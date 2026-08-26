import { planFor, needsExtraction } from "../src/lib/payload.ts";

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) fail++;
};

const READING = "PROBLEM\nOff-by-one on line 7.";

console.log("\n1. auto: each pane gets what it can use");
{
  const seeing = planFor({ mode: "auto", canSee: true, hasImages: true, context: READING });
  check("a model that can see gets the picture", seeing.sendImages);
  // Back to the picture *instead* of the reading, now that two things have
  // changed: `canSee` is measured rather than assumed, and the transcription
  // comes from an OCR engine rather than a vision model. A pane that reads for
  // itself is an independent reading, and a transcription error then shows up as
  // disagreement in the panel rather than as unanimous confidence in the wrong
  // answer.
  check("and reads the picture itself rather than the transcription", seeing.context === "");
  check("not blind", !seeing.blind);

  const blind = planFor({ mode: "auto", canSee: false, hasImages: true, context: READING });
  check("a model that cannot gets the transcription", blind.context === READING);
  check("and is not sent an image it cannot use", !blind.sendImages);
  check("not blind either -- it has the reading", !blind.blind);
}

console.log("\n2. auto with no reading available");
{
  const blind = planFor({ mode: "auto", canSee: false, hasImages: true, context: "" });
  check("nothing to send it", !blind.sendImages && blind.context === "");
  // The case that produced silent nonsense: a text-only model handed a question
  // about a picture it never saw.
  check("flagged blind so the caller can say so", blind.blind);

  const seeing = planFor({ mode: "auto", canSee: true, hasImages: true, context: "" });
  check("a seeing model is unaffected", seeing.sendImages && !seeing.blind);
}

console.log("\n3. the explicit modes still override");
{
  const img = planFor({ mode: "images", canSee: true, hasImages: true, context: READING });
  check("images: picture, no transcription", img.sendImages && img.context === "");

  const ext = planFor({ mode: "extract", canSee: true, hasImages: true, context: READING });
  check("extract: transcription even for a model that can see", !ext.sendImages && ext.context === READING);

  const both = planFor({ mode: "both", canSee: true, hasImages: true, context: READING });
  check("both: picture and transcription", both.sendImages && both.context === READING);
}

console.log("\n4. extract with a failed vision pass falls back sensibly");
{
  const seeing = planFor({ mode: "extract", canSee: true, hasImages: true, context: "" });
  check("a seeing model gets the picture rather than nothing", seeing.sendImages);

  const blind = planFor({ mode: "extract", canSee: false, hasImages: true, context: "" });
  check("a blind model is not sent an image it cannot read", !blind.sendImages);
  check("and is flagged", blind.blind);
}

console.log("\n5. a typed question needs none of this");
{
  for (const mode of ["auto", "images", "extract", "both"] as const) {
    const p = planFor({ mode, canSee: false, hasImages: false, context: "" });
    check(`${mode}: nothing sent, nothing blind`, !p.sendImages && p.context === "" && !p.blind);
  }
}

console.log("\n6. a picture always earns a reading");
{
  // This was demand-driven -- skipped when every pane could see -- and that was
  // right until a pane's *route* could drop the image while the model behind it
  // saw perfectly well. Nobody looked blind, no reading was made, and those
  // panes just failed. Two calls is the price of every pane having something.
  check("auto, all panes can see: still read it", needsExtraction("auto", true, false));
  check("auto, one pane cannot: run it", needsExtraction("auto", true, true));
  check("images: never", !needsExtraction("images", true, true));
  check("extract: always, even if all can see", needsExtraction("extract", true, false));
  check("both: always", needsExtraction("both", true, false));
  check("no images: never, whatever the mode", !needsExtraction("extract", false, true));
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall payload checks passed\n");
process.exit(fail ? 1 : 0);
