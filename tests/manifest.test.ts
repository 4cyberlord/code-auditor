import { imageManifest, userPrompt, type ImageRef } from "../src/lib/prompts.ts";
import { tileWhere } from "../src/lib/image.ts";

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) fail++;
};

/** n separate captures, each cut into `tiles` pieces. */
const shots = (n: number, tiles = 1): ImageRef[] => {
  const out: ImageRef[] = [];
  for (let g = 1; g <= n; g++) {
    for (let t = 1; t <= tiles; t++) {
      out.push({
        group: `g${g}`,
        tile: { index: t, count: tiles, where: t === 1 ? "left" : "right" },
      });
    }
  }
  return out;
};

console.log("\n1. five screenshots, each cut in two");
{
  const m = imageManifest(shots(5, 2));
  check("counts screenshots, not images", m.includes("5 screenshots"), m.split("\n")[0]);
  check("but says how many images that is", m.includes("as 10 images"), m.split("\n")[0]);
  check("numbers them 1..5", m.includes("Screenshot 1") && m.includes("Screenshot 5"));
  check("never invents a sixth", !m.includes("Screenshot 6"));
  check("names the piece", m.includes("left piece") && m.includes("right piece"));
  check("says they are one problem", m.includes("one problem, not several"));
  check("says later ones may correct earlier", m.includes("correct an earlier one"));
  check("explains the overlap", m.includes("overlap"));
  // Order is the whole point: every line numbered in the order sent.
  const nums = [...m.matchAll(/^\s*(\d+)\./gm)].map((x) => Number(x[1]));
  check("listed in order, 1 to 10", nums.join(",") === "1,2,3,4,5,6,7,8,9,10", nums.join(","));
}

console.log("\n2. the ordinary cases");
{
  const one = imageManifest(shots(1, 1));
  check("a single image says so plainly", one.startsWith("One screenshot is attached."), one);
  check("and does not lecture about ordering", !one.includes("one problem, not several"));
  check("nor about overlap", !one.includes("overlap"));

  const tiled = imageManifest(shots(1, 2));
  check("one screen in pieces explains the cut", tiled.includes("cut into 2 overlapping pieces"), tiled.split("\n")[0]);
  check("still one screenshot", !tiled.includes("2 screenshots"));

  const three = imageManifest(shots(3, 1));
  check("three untiled captures", three.includes("3 screenshots"));
  check("no overlap talk when nothing was cut", !three.includes("overlap"), three);

  check("nothing attached, nothing said", imageManifest([]) === "");
}

console.log("\n3. captures with no group still number correctly");
{
  // Older assets, or anything that arrived without a group id.
  const loose: ImageRef[] = [{}, {}, {}];
  const m = imageManifest(loose);
  check("treated as three separate screenshots", m.includes("3 screenshots"), m.split("\n")[0]);
  check("numbered 1..3", m.includes("Screenshot 3") && !m.includes("Screenshot 4"));
}

console.log("\n4. it reaches the actual prompt");
{
  const p = userPrompt("", true, "", shots(5, 2));
  check("the manifest is in the prompt", p.includes("5 screenshots"), p.slice(0, 80));
  check("with the instruction to read them all", p.includes("Read them, then solve it"));

  const single = userPrompt("", true, "", []);
  check("no manifest falls back to the old wording", single.includes("attached image"), single);

  // A text-only pane gets the reading, not the pictures, so no manifest applies.
  const reading = userPrompt("", false, "PROBLEM\nfoo", shots(3, 2));
  check("a reading-only prompt does not list images", !reading.includes("screenshots are attached"), reading.slice(0, 90));

  const noted = userPrompt("focus on line 7", true, "", shots(2, 1));
  check("the note still arrives", noted.includes("focus on line 7"));
}

console.log("\n5. tile positions are described the way a person would");
{
  check("2x1 left", tileWhere(0, 0, 2, 1) === "left");
  check("2x1 right", tileWhere(1, 0, 2, 1) === "right");
  check("2x2 top-left", tileWhere(0, 0, 2, 2) === "top-left");
  check("2x2 bottom-right", tileWhere(1, 1, 2, 2) === "bottom-right");
  check("3x2 middle column", tileWhere(1, 0, 3, 2) === "top-middle");
  check("1x2 top", tileWhere(0, 0, 1, 2) === "top");
  check("a single tile is the whole thing", tileWhere(0, 0, 1, 1) === "whole");
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall manifest checks passed\n");
process.exit(fail ? 1 : 0);
