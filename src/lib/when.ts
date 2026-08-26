/**
 * One timezone for the whole app.
 *
 * Everything already stored is `timestamptz`, which is an instant rather than a
 * wall-clock reading — the database has never been ambiguous about *when*
 * something happened. What was ambiguous is what the screen said about it: the
 * webview formatted with the browser default, so a session captured at 11pm
 * could read as the next day depending on nothing the user chose.
 *
 * That matters more than it sounds. The point of session history is to find the
 * thing you were working on on Tuesday evening, and a list where "Tuesday
 * evening" silently means UTC is a list you cannot navigate by memory.
 *
 * So: one zone, detected from the machine, anchored to Nashville when detection
 * gives nothing usable, and overridable in Settings for the times you are not at
 * home. Nashville is Central — `America/Chicago` — not Eastern; Tennessee is
 * split down the middle and Nashville is on the western side of the line.
 */

/** Nashville. Central time, and the fallback when detection fails. */
export const HOME_ZONE = "America/Chicago";

/**
 * The machine's own zone, when it has a usable one.
 *
 * `resolvedOptions()` can return "UTC" on a machine with nothing configured,
 * which is not a place anybody is, and treating it as a real answer is how a
 * container's timezone ends up on a person's screen.
 */
export function detectZone(): string {
  try {
    const found = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!found || found === "UTC" || !found.includes("/")) return HOME_ZONE;
    return found;
  } catch {
    return HOME_ZONE;
  }
}

/** Whether a zone string is one this machine's Intl can actually use. */
export function isUsableZone(zone: string): boolean {
  if (!zone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

const safeZone = (zone: string) => (isUsableZone(zone) ? zone : HOME_ZONE);

/**
 * A timestamp as a person in that zone would say it.
 *
 * "full" for a detail view, "short" for a list, "time" when the day is already
 * established by a heading. Relative wording — "just now", "20 minutes ago" —
 * is deliberately only used for the last day: past that it stops being easier to
 * read than a date and starts being harder.
 */
export function formatWhen(
  when: string | number | Date,
  zone: string = HOME_ZONE,
  style: "full" | "short" | "time" | "relative" = "short"
): string {
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime())) return "";
  const tz = safeZone(zone);

  if (style === "relative") {
    const secs = Math.round((Date.now() - d.getTime()) / 1000);
    if (secs < 45) return "just now";
    if (secs < 90) return "a minute ago";
    if (secs < 3600) return `${Math.round(secs / 60)} minutes ago`;
    if (secs < 5400) return "an hour ago";
    if (secs < 86400) return `${Math.round(secs / 3600)} hours ago`;
    // Older than a day: a date is easier to place than "31 hours ago".
    return formatWhen(d, tz, "short");
  }

  const opts: Intl.DateTimeFormatOptions =
    style === "time"
      ? { hour: "numeric", minute: "2-digit", timeZone: tz }
      : style === "full"
        ? {
            weekday: "short",
            day: "numeric",
            month: "short",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZone: tz,
            timeZoneName: "short",
          }
        : {
            day: "numeric",
            month: "short",
            hour: "numeric",
            minute: "2-digit",
            timeZone: tz,
          };

  return new Intl.DateTimeFormat("en-US", opts).format(d);
}

/**
 * The zone's short name at that moment — "CDT" in July, "CST" in January.
 *
 * Taken at a given instant rather than stored, because the abbreviation is a
 * property of the date and not of the zone. A run from January labelled CDT is
 * wrong by an hour to anyone reading carefully.
 */
export function zoneAbbrev(zone: string = HOME_ZONE, at: Date = new Date()): string {
  const tz = safeZone(zone);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "short",
    }).formatToParts(at);
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

/** "Nashville time (CDT)" — what Settings shows next to the picker. */
export function zoneLabel(zone: string = HOME_ZONE, at: Date = new Date()): string {
  const tz = safeZone(zone);
  const city = tz.split("/").pop()?.replace(/_/g, " ") ?? tz;
  const abbr = zoneAbbrev(tz, at);
  const name = tz === HOME_ZONE ? "Nashville" : city;
  return abbr ? `${name} time (${abbr})` : `${name} time`;
}

/**
 * The day a timestamp falls on *in that zone*, as `YYYY-MM-DD`.
 *
 * Grouping a history list by day is the one place the zone genuinely changes
 * the answer rather than the wording: an 11pm capture in Nashville is already
 * tomorrow in UTC, and grouping by the UTC date puts it under a heading the
 * person never experienced.
 */
export function dayKey(when: string | number | Date, zone: string = HOME_ZONE): string {
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: safeZone(zone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  // en-CA formats as YYYY-MM-DD, which is what makes it sortable.
  return parts;
}
