/** Auditable labels are model claims and static clues, not E2B proofs. */
function claimFor(label,text) {
  const pattern=new RegExp("\\b"+label+"(?:\\s+complexity)?\\s*[:=]\\s*(O\\s*\\([^\\n;]+?\\))","i");
  const match=pattern.exec(String(text||""));
  return match ? match[1].replace(/\s+/g," ").slice(0,90) : null;
}
export function analyzePortSource(final,run,sourceBlueprint) {
  const code=String(final?.code||"").slice(0,30000);
  const claim=String(final?.complexity||"");
  const explanation=String(final?.answer||"").slice(0,450);
  const staticClues=[];
  if (/\b(?:HashMap|unordered_map|BTreeMap)\b/.test(code))staticClues.push("map");
  if (/\b(?:HashSet|unordered_set|BTreeSet)\b/.test(code))staticClues.push("set");
  if (/\b(?:priority_queue|BinaryHeap)\b/.test(code))staticClues.push("heap");
  if (/\b(?:sort_unstable|sort_by|\.sort\(|std::sort|stable_sort)\b/.test(code))staticClues.push("sorting");
  if (/\b(?:binary_search|lower_bound|upper_bound)\b/.test(code))staticClues.push("binary-search");
  if (/\b(?:queue|VecDeque|deque)\b/.test(code))staticClues.push("queue");
  const time=claimFor("time",claim);
  const space=claimFor("space",claim);
  return {
    algorithmUsed:explanation || sourceBlueprint?.explanation || null,
    dataStructureClues:staticClues,
    timeComplexityClaim:time,
    spaceComplexityClaim:space,
    rawComplexityClaim:claim.slice(0,180)||null,
    derivationStatus:"model-claimed-not-proven",
    instrumentation:{
      harnessDurationMs:run?.remoteElapsedMs??null,
      compiledTotalMs:run?.totalElapsedMs??null,
      peakHarnessMemoryKb:run?.peakMemoryKb??null,
      includesTestHarness:true,
    },
    warning:"Elapsed time and RSS are empirical harness measurements, not Big-O bounds; complexity requires independent structural review."
  };
}
