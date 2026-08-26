import { planTiles, captureNameOf } from "../src/lib/image.ts";

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) fail++;
};

const px = (scale: number) => 14 * scale;

console.log("\n1. small pictures are left completely alone");
{
  for (const [w, h] of [[1100, 700], [800, 600], [1568, 900], [400, 300]] as const) {
    const p = planTiles(w, h);
    check(`${w}x${h}: one tile, untouched`, p.cols === 1 && p.rows === 1 && p.scale === 1);
  }
}

console.log("\n2. whole screens are tiled rather than shrunk into mush");
{
  const screens: [string, number, number][] = [
    ['MacBook Air 13"', 2560, 1664],
    ['MacBook Pro 16"', 3456, 2234],
    ["5K display", 5120, 2880],
    ["ultrawide", 5120, 1440],
  ];
  for (const [name, w, h] of screens) {
    const p = planTiles(w, h);
    // The whole point: text has to stay readable. Scaling alone gets a 16" screen
    // to about 6px, which is where a model starts guessing at glyphs.
    check(
      `${name}: text stays legible (${px(p.scale).toFixed(1)}px)`,
      px(p.scale) >= 11,
      `scale ${p.scale.toFixed(2)}`
    );
    check(`${name}: within the tile budget (${p.cols}x${p.rows})`, p.cols * p.rows <= 6);
  }
}

console.log("\n3. no more tiles than the job needs");
{
  const air = planTiles(2560, 1664);
  const pro = planTiles(3456, 2234);
  const fivek = planTiles(5120, 2880);
  check("a smaller screen uses no more tiles than a bigger one", air.cols * air.rows <= pro.cols * pro.rows);
  check("and the biggest uses the most", pro.cols * pro.rows <= fivek.cols * fivek.rows);
  check("a 13-inch needs only two", air.cols * air.rows === 2, String(air.cols * air.rows));
}

console.log("\n4. degenerate inputs do not produce a degenerate plan");
{
  for (const [w, h] of [[1, 1], [20000, 10], [10, 20000], [16000, 16000]] as const) {
    const p = planTiles(w, h);
    check(
      `${w}x${h}: a usable grid`,
      p.cols >= 1 && p.rows >= 1 && p.cols * p.rows <= 6 && p.scale > 0 && p.scale <= 1,
      JSON.stringify(p)
    );
  }
  // Something enormous cannot reach the target at any grid size. The invariant
  // is not "use all six tiles" -- on a square image 2x2 reaches the same scale
  // as 3x2, and paying for two extra images to gain nothing would be wrong. It
  // is that nothing affordable does better.
  for (const [w, h] of [[16000, 16000], [12000, 9000], [20000, 400]] as const) {
    const got = planTiles(w, h);
    let bestPossible = 0;
    for (let cols = 1; cols <= 6; cols++) {
      for (let rows = 1; rows <= 6; rows++) {
        if (cols * rows > 6) continue;
        bestPossible = Math.max(bestPossible, Math.min(1, 1568 / Math.max(w / cols, h / rows)));
      }
    }
    check(
      `${w}x${h}: no affordable grid beats the one chosen`,
      got.scale >= bestPossible - 1e-9,
      `chose ${got.scale.toFixed(3)}, best possible ${bestPossible.toFixed(3)}`
    );
  }
}

console.log("\n6. naming a reading after the capture it describes");
{
  check("a plain capture", captureNameOf([{ name: "capture-1756000000000.png" }]) === "capture-1756000000000.png");
  // A whole-screen grab becomes tiles; they all describe one file on disk.
  check(
    "a tile still points at the whole capture",
    captureNameOf([{ name: "capture-1756000000000.png (2 of 4)" }]) === "capture-1756000000000.png"
  );
  check(
    "the first capture wins when several are loaded",
    captureNameOf([{ name: "photo.jpg" }, { name: "capture-99.png" }, { name: "capture-1.png" }]) ===
      "capture-99.png"
  );
  // A pasted or dragged file has no capture on disk to sit beside, so it must
  // not borrow a name that implies one.
  check("a pasted image has no capture name", captureNameOf([{ name: "Screenshot 2026.png" }]) === null);
  check("nor a lookalike", captureNameOf([{ name: "capture-abc.png" }]) === null);
  check("nor a path pretending to be a name", captureNameOf([{ name: "../capture-1.png" }]) === null);
  check("nothing loaded, nothing named", captureNameOf([]) === null);
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall image checks passed\n");
process.exit(fail ? 1 : 0);
