import {
  HOME_ZONE,
  detectZone,
  isUsableZone,
  formatWhen,
  zoneAbbrev,
  zoneLabel,
  dayKey,
} from "../src/lib/when.ts";

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) fail++;
};

// 2026-07-04T02:30:00Z is 2026-07-03 21:30 in Nashville — a different DAY.
const SUMMER_NIGHT = "2026-07-04T02:30:00Z";
// 2026-01-15T12:00:00Z is 06:00 CST.
const WINTER_NOON = "2026-01-15T12:00:00Z";

console.log("\n1. Nashville is Central, not Eastern");
{
  check("the home zone is America/Chicago", HOME_ZONE === "America/Chicago", HOME_ZONE);
  check("summer is CDT", zoneAbbrev(HOME_ZONE, new Date(SUMMER_NIGHT)) === "CDT", zoneAbbrev(HOME_ZONE, new Date(SUMMER_NIGHT)));
  // The abbreviation belongs to the date, not the zone. A January run labelled
  // CDT is wrong by an hour to anyone reading carefully.
  check("winter is CST", zoneAbbrev(HOME_ZONE, new Date(WINTER_NOON)) === "CST", zoneAbbrev(HOME_ZONE, new Date(WINTER_NOON)));
  check("the label names the city", zoneLabel(HOME_ZONE, new Date(SUMMER_NIGHT)) === "Nashville time (CDT)", zoneLabel(HOME_ZONE, new Date(SUMMER_NIGHT)));
  check("another zone is named after its own city", zoneLabel("Europe/London", new Date(SUMMER_NIGHT)).startsWith("London time"), zoneLabel("Europe/London"));
  check("underscores are not shown", zoneLabel("America/New_York").includes("New York"), zoneLabel("America/New_York"));
}

console.log("\n2. the clock reads as Nashville, not as UTC");
{
  const t = formatWhen(SUMMER_NIGHT, HOME_ZONE, "time");
  check("02:30 UTC is 9:30 PM in Nashville", t === "9:30 PM", t);
  const utc = formatWhen(SUMMER_NIGHT, "UTC", "time");
  check("and 2:30 AM in UTC", utc === "2:30 AM", utc);

  const w = formatWhen(WINTER_NOON, HOME_ZONE, "time");
  check("winter noon UTC is 6:00 AM", w === "6:00 AM", w);
}

console.log("\n3. the day is the day you lived, not the day in UTC");
{
  // This is the one place the zone changes the answer rather than the wording.
  check("a late-night capture stays on its own day", dayKey(SUMMER_NIGHT, HOME_ZONE) === "2026-07-03", dayKey(SUMMER_NIGHT, HOME_ZONE));
  check("UTC would have called it tomorrow", dayKey(SUMMER_NIGHT, "UTC") === "2026-07-04", dayKey(SUMMER_NIGHT, "UTC"));
  check("and it sorts", dayKey("2026-01-02T18:00:00Z") < dayKey("2026-01-03T18:00:00Z"));
}

console.log("\n4. detection never lands somewhere nobody is");
{
  check("the detected zone is usable", isUsableZone(detectZone()), detectZone());
  check("a real zone is accepted", isUsableZone("America/Chicago"));
  check("nonsense is not", !isUsableZone("Middle/Earth"));
  check("empty is not", !isUsableZone("   "));
  // A bad saved value must format rather than throw, or one stale setting
  // blanks every timestamp in the window.
  check("a bad zone falls back rather than throwing", formatWhen(WINTER_NOON, "Middle/Earth", "time") === "6:00 AM", formatWhen(WINTER_NOON, "Middle/Earth", "time"));
}

console.log("\n5. relative wording only where it helps");
{
  const now = Date.now();
  check("seconds ago", formatWhen(now - 5_000, HOME_ZONE, "relative") === "just now");
  check("a minute", formatWhen(now - 65_000, HOME_ZONE, "relative") === "a minute ago");
  check("minutes", formatWhen(now - 20 * 60_000, HOME_ZONE, "relative") === "20 minutes ago", formatWhen(now - 20 * 60_000, HOME_ZONE, "relative"));
  check("hours", formatWhen(now - 5 * 3_600_000, HOME_ZONE, "relative") === "5 hours ago", formatWhen(now - 5 * 3_600_000, HOME_ZONE, "relative"));
  // Past a day, "31 hours ago" is harder to place than a date.
  const old = formatWhen(now - 40 * 3_600_000, HOME_ZONE, "relative");
  check("older than a day becomes a date", !old.includes("ago"), old);
}

console.log("\n6. rubbish in, nothing out — never 'Invalid Date'");
{
  check("empty string", formatWhen("", HOME_ZONE) === "");
  check("not a date", formatWhen("banana", HOME_ZONE) === "");
  check("and no day key either", dayKey("banana") === "");
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall time checks passed\n");
process.exit(fail ? 1 : 0);
