import { EMPTY_EXTRACTION } from "../src/lib/extraction.ts";
import { routeCloudModels, trustedCloudReading } from "../src/lib/backgroundIntelligence.ts";
const check = (name: string, ok: boolean) => {
  if (!ok) throw new Error(name);
  console.log("PASS:", name);
};
const reading = {
  extraction: {
    ...EMPTY_EXTRACTION,
    problemSummary: "Find shortest path in a graph",
    observations: [],
    confidence: 0.95,
    ambiguities: [],
  },
  context: "Find shortest path",
  readerEvidence: [
    { confidence: 0.94, ambiguities: [] },
    { confidence: 0.96, ambiguities: [] },
  ],
  agreement: { agree: true },
};
const models = [
  { id: "general" },
  { id: "graph-specialist", expertise: ["graph"] as const },
  { id: "unsupported", vision: true },
];
const settings = { probes: {
  "graph-specialist": { vision: true, ok: true, ms: 100 },
  general: { vision: false, ok: true, ms: 300 },
} };
const ranked = routeCloudModels(settings, models, reading, false);
check("uses shared graph classification", ranked.route.families.includes("graph"));
check("ranks domain specialist first", ranked.selection.selected[0]?.id === "graph-specialist");
const image = routeCloudModels(settings, models, reading, true);
check("only probed vision models receive images",
  image.selection.selected.length === 1 && image.selection.selected[0]?.id === "graph-specialist");
check("unverified manual vision claim cannot receive pixels",
  !image.selection.selected.some(m => m.id === "unsupported"));
check("two clean agreeing readings permit text-only reasoning", trustedCloudReading(reading));
check("one reader cannot authorize text-only", !trustedCloudReading({
  ...reading, readerEvidence: reading.readerEvidence.slice(0, 1),
}));
check("disagreeing readings retain pixels", !trustedCloudReading({
  ...reading, agreement: { agree: false },
}));
check("diagram uncertainty retains pixels", !trustedCloudReading({
  ...reading, extraction: {
    ...reading.extraction, observations: ["Diagram shows a graph image with connecting arrows"],
  },
}));
check("symbol ambiguities retain pixels", !trustedCloudReading({
  ...reading, extraction: { ...reading.extraction, ambiguities: ["cropped mathematical symbol"] },
}));
check("unparsed screenshots require image-capable models",
  routeCloudModels(settings, models, null, true).selection.selected.length === 1);
