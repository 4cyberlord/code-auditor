import { preflight, pace, gatewayRequests } from "../src/lib/preflight.ts";
import { ALL_AGENTS, type AgentId } from "../src/lib/models.ts";

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) fail++;
};

const on = (...ids: AgentId[]) =>
  Object.fromEntries(ALL_AGENTS.map((a) => [a, ids.includes(a)])) as Record<AgentId, boolean>;

// The preflight gates on declared vision capability, not on which vendors
// ship. All four built-in panes (OpenAI, Moonshot, Anthropic, Gemini) are
// vision-capable in the table; the role previously played by the two free
// text-only panes has to be simulated by overriding the capability table.
// They are chosen so the *panes* being blinded are never also the *readers*
// being consulted, because a blind pane pretending to transcribe itself is the
// accident that made the old tests pass by coincidence of names.
const TEXT_ONLY: AgentId[] = ["openai", "moonshot"]; // blinded via sees: below

console.log("\n1. a typed question needs nothing special");
{
  const r = preflight({
    imageCount: 0,
    contextMode: "images",
    enabled: on(...TEXT_ONLY),
    reachable: TEXT_ONLY,
    extractors: ["anthropic", "openai"],
    sees: { openai: false, moonshot: false },
  });
  check("text-only models are fine with text", r.blocking === null, String(r.blocking));
  check("and there is nothing to caution about", r.caution === null, String(r.caution));
}

console.log("\n2. a screenshot handed to models that cannot see");
{
  const r = preflight({
    imageCount: 1,
    contextMode: "images",
    enabled: on(...TEXT_ONLY),
    reachable: TEXT_ONLY,
    extractors: ["anthropic", "openai"],
    sees: { openai: false, moonshot: false },
  });
  check("blocked, not merely cautioned", r.blocking !== null);
  check("names the models", (r.blocking ?? "").includes("GPT") || (r.blocking ?? "").includes("Kimi"), String(r.blocking));
  check("offers the Reading route", (r.blocking ?? "").includes("Reading"), String(r.blocking));
  check("offers typing instead", (r.blocking ?? "").includes("type the problem"), String(r.blocking));
}

console.log("\n3. a mixed panel keeps working, with a caveat");
{
  const r = preflight({
    imageCount: 2,
    contextMode: "images",
    enabled: on("anthropic", ...TEXT_ONLY),
    reachable: ["anthropic", ...TEXT_ONLY],
    extractors: ["anthropic", "openai"],
    sees: { openai: false, moonshot: false },
  });
  check("not blocked -- Claude can still see", r.blocking === null, String(r.blocking));
  check("but says the blind ones will not", r.caution !== null);
  check("names them", (r.caution ?? "").includes("Kimi"), String(r.caution));
}

console.log("\n4. Reading mode with unreachable readers");
{
  // Blind panes on, and neither declared reader is reachable. The extractors
  // must be different agents from the blinded panes so this measures what it
  // should.
  const r = preflight({
    imageCount: 1,
    contextMode: "extract",
    enabled: on(...TEXT_ONLY),
    reachable: TEXT_ONLY,
    extractors: ["anthropic", "gemini"],
    sees: { openai: false, moonshot: false },
  });
  check("blocked before any request goes out", r.blocking !== null);
  check("names both readers", (r.blocking ?? "").includes("Claude") && (r.blocking ?? "").includes("Gemini"), String(r.blocking));
  check("points at the Reading settings", (r.blocking ?? "").includes("Reading"), String(r.blocking));
  check("says text would work", (r.blocking ?? "").includes("read text"), String(r.blocking));
}

console.log("\n4b. Reading mode with one unreachable reader names just that one");
{
  const r = preflight({
    imageCount: 1,
    contextMode: "extract",
    enabled: on(...TEXT_ONLY),
    reachable: [...TEXT_ONLY, "anthropic"],
    extractors: ["anthropic", "gemini"],
    sees: { openai: false, moonshot: false },
  });
  check("runs with a caveat, not a block", r.blocking === null, String(r.blocking));
  check("warns that nothing cross-checks it", (r.caution ?? "").includes("cross-checked"), String(r.caution));
}

console.log("\n5. one reader is allowed, but not silently");
{
  // Only the readers we send the screenshot to are Gemini and Claude; neither
  // blind pane is also being asked to read its own picture.
  const r = preflight({
    imageCount: 1,
    contextMode: "extract",
    enabled: on(...TEXT_ONLY),
    reachable: [...TEXT_ONLY, "anthropic"],
    extractors: ["anthropic", "gemini"],
    sees: { openai: false, moonshot: false },
  });
  check("runs", r.blocking === null, String(r.blocking));
  check("warns that nothing cross-checks it", (r.caution ?? "").includes("cross-checked"), String(r.caution));
}

console.log("\n6. nothing switched on, and nothing reachable");
{
  const a = preflight({ imageCount: 0, contextMode: "images", enabled: on(), reachable: [], extractors: [] });
  check("no panes at all is its own message", (a.blocking ?? "").includes("switched off"), String(a.blocking));

  const b = preflight({
    imageCount: 0,
    contextMode: "images",
    enabled: on("openai"),
    reachable: [],
    extractors: [],
  });
  check("switched on but unreachable reads differently", (b.blocking ?? "").includes("can be reached"), String(b.blocking));
  check("and it is not the same message", a.blocking !== b.blocking);
}

console.log("\n7. the fully-configured happy path stays quiet");
{
  const r = preflight({
    imageCount: 1,
    contextMode: "extract",
    enabled: on("openai", "anthropic", ...TEXT_ONLY),
    reachable: ["openai", "anthropic", ...TEXT_ONLY],
    extractors: ["anthropic", "openai"],
    sees: { moonshot: false },
  });
  check("no blocking", r.blocking === null, String(r.blocking));
  check("no caution", r.caution === null, String(r.caution));
}

console.log("\n8. auto mode: the mixed panel that started all this");
{
  // Blinded panes only, a screenshot, and a token that cannot reach either
  // reader. The mixed-panel cases openAI and Moonshot blind, and readers on
  // models the key does not cover.
  const stuck = preflight({
    imageCount: 1,
    contextMode: "auto",
    enabled: on(...TEXT_ONLY),
    reachable: TEXT_ONLY,
    extractors: ["anthropic", "gemini"],
    sees: { openai: false, moonshot: false },
  });
  check("blocked, and says to type it instead", (stuck.blocking ?? "").includes("Type the problem"), String(stuck.blocking));

  // One paid vision model present: the run is worth doing, with a caveat.
  const mixed = preflight({
    imageCount: 1,
    contextMode: "auto",
    enabled: on("anthropic", ...TEXT_ONLY),
    reachable: ["anthropic", ...TEXT_ONLY],
    extractors: ["openai", "gemini"],
    sees: { openai: false, moonshot: false },
  });
  check("not blocked -- Claude can still answer", mixed.blocking === null, String(mixed.blocking));
  // The pre-one-reader-caution path used to say "note alone". The corrected
  // message names the same condition honestly: a blind pane is still answering,
  // just from a single un-cross-checked transcription instead of from an actual
  // reading.
  check(
    "but says the blind ones work from the note",
    (mixed.caution ?? "").includes("note alone") ||
      (mixed.caution ?? "").includes("will answer from") ||
      ((mixed.caution ?? "").includes("cannot read images") && (mixed.caution ?? "").includes("not cross-checked")),
    String(mixed.caution)
  );

  // A reader is reachable, so nobody is left out and nothing needs saying.
  const fine = preflight({
    imageCount: 1,
    contextMode: "auto",
    enabled: on("anthropic", ...TEXT_ONLY),
    reachable: ["anthropic", "openai", ...TEXT_ONLY],
    extractors: ["anthropic", "openai"],
    sees: { openai: false, moonshot: false },
  });
  check("silent once a reader is reachable", fine.blocking === null && fine.caution === null);

  // All-seeing panel: auto must not invent a reason to warn.
  const allSeeing = preflight({
    imageCount: 1,
    contextMode: "auto",
    enabled: on("anthropic", "openai"),
    reachable: ["anthropic", "openai"],
    extractors: ["anthropic", "openai"],
  });
  check("a panel that can all see is left alone", allSeeing.blocking === null && allSeeing.caution === null);
}

console.log("\n9. a screenshot shrunk past the point of being readable");
{
  const ALL: AgentId[] = ["anthropic", "openai"];
  const base = {
    imageCount: 1,
    contextMode: "auto" as const,
    enabled: on(...ALL),
    reachable: ALL,
    extractors: ALL,
  };

  const whole = preflight({ ...base, smallestScale: 0.31 });
  check("cautions, but does not block", whole.blocking === null && whole.caution !== null);
  check("says why it matters", (whole.caution ?? "").includes("may not be readable"), String(whole.caution));
  check("names the region shortcut", (whole.caution ?? "").includes("⌃⌥R"), String(whole.caution));

  const region = preflight({ ...base, smallestScale: 1 });
  check("a full-size capture is left alone", region.caution === null, String(region.caution));

  // Not knowing the scale must not invent a warning.
  const unknown = preflight(base);
  check("missing scale is treated as full size", unknown.caution === null, String(unknown.caution));

  // A real problem still outranks a legibility note: a blind pane on a
  // screenshot with no image-capable peers and no readable backup is a
  // blocking condition, and saying so beats explaining the resolution plan.
  const blocked = preflight({
    imageCount: 1,
    contextMode: "images",
    enabled: on("openai"),
    reachable: ["openai"],
    extractors: ["anthropic", "gemini"],
    sees: { openai: false, anthropic: false, gemini: true },
    smallestScale: 0.2,
  });
  check("a blocking problem still wins", blocked.blocking !== null);
}

console.log("\n10. measurement outranks the capability table");
{
  // Google is declared vision-capable, and is. Through this gateway it had its
  // connection dropped the moment an image part was attached -- so for this
  // route it is blind, and the app has to know that before the run rather than
  // after four identical failures.
  const base = {
    imageCount: 1,
    contextMode: "images" as const,
    enabled: on("anthropic", "gemini"),
    reachable: ["anthropic", "gemini"] as AgentId[],
    extractors: ["anthropic", "openai"] as AgentId[],
  };

  const declared = preflight(base);
  check("the table alone sees no problem", declared.caution === null, String(declared.caution));

  const measured = preflight({ ...base, sees: { gemini: false } });
  check("a measured failure is cautioned", measured.caution !== null);
  check("and it names the model", (measured.caution ?? "").includes("Gemini"), String(measured.caution));
  check("but does not block, since one pane still sees", measured.blocking === null, String(measured.blocking));

  // Both measured blind, images-only: nothing in the panel can read the picture.
  const none = preflight({ ...base, sees: { gemini: false, anthropic: false } });
  check("all blind blocks outright", none.blocking !== null, String(none.blocking));

  // The other direction matters just as much: the table says a model is
  // text-only, the probe says it read the test image anyway. Believe the probe,
  // and stop paying for a transcription nobody needs.
  const blindAllowed = preflight({
    imageCount: 1,
    contextMode: "auto",
    enabled: on("openai"),
    reachable: ["openai"],
    extractors: [],
    sees: { openai: true },
  });
  check("a measured success clears the blocker", blindAllowed.blocking === null, String(blindAllowed.blocking));

  // Without the measurement the table's declaration stands, and the table
  // declares vision — so nothing blocks. The polemic case is the inverse test
  // up in section 2, where the table is overridden *down* to blind.
  const declaredSees = preflight({
    imageCount: 1,
    contextMode: "auto",
    enabled: on("openai"),
    reachable: ["openai"],
    extractors: [],
  });
  check("and without a measurement, the table's declaration stands", declaredSees.blocking === null);

  // An unmeasured agent must keep its declared capability, not default to blind.
  const partial = preflight({ ...base, sees: { gemini: false } });
  check("unmeasured agents keep the table's answer", (partial.caution ?? "").includes("Claude") === false || partial.blocking === null);
}

console.log("\n11. the request budget is spent before it is felt");
{
  check("inside budget says nothing", pace(5, 5) === null);
  check("one over warns", pace(6, 5) !== null);

  const w = pace(8, 5) ?? "";
  check("counts the requests", w.includes("8 requests"), w);
  check("names the budget", w.includes("5 a minute"), w);
  check("promises nothing fails", w.includes("Nothing will fail"), w);
  check("offers both ways out", w.includes("switch some panes off") && w.includes("Settings"), w);
  check("8 over 5 is one window", w.includes("about a minute"), w);
  check("11 over 5 is two", (pace(11, 5) ?? "").includes("about 2 minutes"), String(pace(11, 5)));

  // A nonsense budget must not divide by zero or promise an instant run.
  check("zero is treated as one", (pace(3, 0) ?? "").includes("1 a minute"), String(pace(3, 0)));

  // Counting: only what actually goes through the gateway.
  const base = {
    panesOnGateway: 6,
    readersOnGateway: 1,
    hasImages: true,
    contextMode: "auto" as const,
    autoJudge: true,
    judgeOnGateway: true,
  };
  check("panes + reader + judge", gatewayRequests(base) === 8);
  check("no picture, no reader", gatewayRequests({ ...base, hasImages: false }) === 7);
  check("images mode skips the reader", gatewayRequests({ ...base, contextMode: "images" }) === 7);
  check("no auto-judge, no judge request", gatewayRequests({ ...base, autoJudge: false }) === 7);
  check(
    "a pane on its own vendor key does not spend the budget",
    gatewayRequests({ ...base, panesOnGateway: 4 }) === 6
  );
  check("two readers cost two", gatewayRequests({ ...base, readersOnGateway: 2 }) === 9);

  // With a transcriber the picture never reaches a model. Interpreting the text
  // still costs one request, and only when somebody actually needs it.
  check("ocr + a blind pane: one reading request", gatewayRequests({ ...base, ocr: true, anyBlind: true }) === 8);
  check("ocr + two readers is still one", gatewayRequests({ ...base, ocr: true, anyBlind: true, readersOnGateway: 2 }) === 8);
  check("ocr and every pane can see: free", gatewayRequests({ ...base, ocr: true, anyBlind: false }) === 7);
  check("ocr with no picture: nothing to read", gatewayRequests({ ...base, ocr: true, anyBlind: true, hasImages: false }) === 7);
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall preflight checks passed\n");
process.exit(fail ? 1 : 0);
