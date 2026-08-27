import {
  PIN_LENGTH,
  sanitizePin,
  pinProblem,
  usernameProblem,
  lockSecondsLeft,
  humanSeconds,
} from "../src/lib/pin.ts";

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) fail++;
};

console.log("\n1. the field only ever holds four digits");
{
  check("letters are dropped", sanitizePin("12ab34") === "1234");
  check("longer input is cut, not rejected", sanitizePin("987654") === "9876");
  check("spaces and dashes go too", sanitizePin("1 2-3 4") === "1234");
  check("an empty string stays empty", sanitizePin("") === "");
  // Paste is the case that matters: the field has maxLength, but a paste of a
  // longer string arrives as one change event and has to survive it.
  check("a pasted card number does not overflow", sanitizePin("4111111111111111").length === PIN_LENGTH);
}

console.log("\n2. the shape rules");
{
  check("four digits is fine", pinProblem("2846") === null);
  check("three is not", pinProblem("284") !== null);
  check("five is not", pinProblem("28465") !== null);
  check("letters are not", pinProblem("28a6") !== null);
  check("empty is not", pinProblem("") !== null);
}

console.log("\n3. the PINs everyone picks are refused");
{
  // The whole reason a 4-digit PIN is survivable is the lockout after five
  // tries. That budget is worth nothing if the first five guesses are this good.
  for (const bad of ["0000", "1111", "9999", "1234", "4321", "1212", "6969", "1010", "2000", "1122"]) {
    check(`${bad} is refused`, pinProblem(bad) !== null);
  }
}

console.log("\n4. and ordinary ones are not");
{
  for (const good of ["2846", "9153", "3708", "5291", "8264"]) {
    check(`${good} is allowed`, pinProblem(good) === null, pinProblem(good) ?? "");
  }
  // A near-miss on each pattern rule, so the rules cannot quietly widen.
  check("1235 is not a run", pinProblem("1235") === null);
  check("1213 does not repeat a pair", pinProblem("1213") === null);
  check("1112 is not all one digit", pinProblem("1112") === null);
}

console.log("\n5. usernames");
{
  check("an ordinary one passes", usernameProblem("charles") === null);
  check("dots, dashes and underscores pass", usernameProblem("charles.a_duboakye-70") === null);
  check("two characters is too short", usernameProblem("ab") !== null);
  check("33 is too long", usernameProblem("x".repeat(33)) !== null);
  check("32 is not", usernameProblem("x".repeat(32)) === null);
  check("spaces are refused", usernameProblem("has space") !== null);
  check("surrounding space is trimmed, not refused", usernameProblem("  charles  ") === null);
  check("an empty name is refused", usernameProblem("") !== null);
}

console.log("\n6. the lockout countdown");
{
  const now = Date.parse("2026-08-26T12:00:00Z");
  const in90s = "2026-08-26T12:01:30Z";
  check("90 seconds away reads as 90", lockSecondsLeft(in90s, now) === 90);
  check("null is not locked", lockSecondsLeft(null, now) === 0);
  check("rubbish is not locked", lockSecondsLeft("banana", now) === 0);
  // A countdown that keeps running past zero is how a UI shows it stopped
  // paying attention. It clamps instead.
  check("a past time never goes negative", lockSecondsLeft("2026-08-26T11:00:00Z", now) === 0);
}

console.log("\n7. and how it reads");
{
  check("seconds", humanSeconds(45) === "45 seconds");
  check("one second is singular", humanSeconds(1) === "1 second");
  check("minutes round up, never down", humanSeconds(90) === "2 minutes");
  check("one minute is singular", humanSeconds(60) === "1 minute");
  check("hours", humanSeconds(3 * 3600) === "3 hours");
  check("one hour is singular", humanSeconds(3600) === "1 hour");
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall auth checks passed\n");
process.exit(fail ? 1 : 0);
