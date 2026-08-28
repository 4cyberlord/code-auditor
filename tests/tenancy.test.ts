/**
 * Every server operation is scoped to the person asking.
 *
 * `ops.ts` runs on the admin client, which bypasses row level security
 * completely — that is the entire point of the Edge Function, and it means an
 * `.eq("owner_id", principal.userId)` is the only thing standing between two
 * people's data. A missing one does not throw, does not log, and does not show
 * up in normal use, because both users see plausible rows. It shows up when
 * somebody notices their history contains a problem they never solved.
 *
 * So this reads the file and refuses to let a query through unscoped. It is a
 * lint, not a proof — `scripts/test-tenancy.mjs` is the proof, because it signs
 * in as a second account and asks for the first one's rows by id. This one runs
 * in `npm test` with no database, which is why it exists too: the expensive
 * check nobody runs is worth less than the cheap check that runs every time.
 */

import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../supabase/functions/council-editor-api/ops.ts", import.meta.url), "utf8");

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  " + extra}`);
  if (!cond) fail++;
};

/**
 * Tables reachable only through a parent that was already checked. Both are
 * keyed by `run_id`, and the only op that reads them has just proved the run
 * belongs to the caller, so they carry no `owner_id` of their own by design.
 */
const REACHED_THROUGH_PARENT = new Set(["agent_responses", "verdicts"]);

/**
 * Not every owned table is scoped by `owner_id`. `app_sessions` predates the
 * tenancy work and carries `user_id`, and the operations that touch it narrow to
 * one row by `principal.sessionId`. So the rule is not "mentions owner_id" — it
 * is "constrains the query by something that came from the token".
 */
const SCOPED_BY_PRINCIPAL = new Set(["app_sessions"]);

/** Split the OPS table into one block per handler. */
function handlers(): Array<{ name: string; body: string }> {
  const found: Array<{ name: string; body: string }> = [];
  const starts = [...src.matchAll(/^ {2}"([a-z]+\.[a-zA-Z]+)": async \(/gm)];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].index!;
    const to = i + 1 < starts.length ? starts[i + 1].index! : src.length;
    found.push({ name: starts[i][1], body: src.slice(from, to) });
  }
  return found;
}

const ops = handlers();

console.log("\n1. every operation is found");
// The count is asserted rather than derived so that adding an operation is a
// deliberate act that also updates this file — which is where someone is
// reminded that a new handler needs a scope.
check("thirty-two handlers", ops.length === 32, `found ${ops.length}: ${ops.map((o) => o.name).join(", ")}`);

// The unauthenticated surface of the whole API. If this ever grows, it should be
// because somebody decided to grow it, not because a handler was added to the
// wrong table.
const publicOps = [...src.matchAll(/^ {2}"([a-z]+\.[a-zA-Z]+)": \(admin/gm)].map((m) => m[1]);
check("exactly one operation needs no sign-in", publicOps.length === 1, publicOps.join(", "));
check("and it is auth.login", publicOps[0] === "auth.login", String(publicOps[0]));

console.log("\n2. every query is scoped to the caller");
for (const op of ops) {
  const tables = [...op.body.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1]);
  const needsScope = tables.filter((t) => !REACHED_THROUGH_PARENT.has(t));
  if (!needsScope.length) {
    check(`${op.name} touches no owned table`, true);
    continue;
  }

  if (needsScope.every((t) => SCOPED_BY_PRINCIPAL.has(t))) {
    check(
      `${op.name} narrows ${needsScope.join(", ")} to the token's own row`,
      /\.eq\("(id|user_id)", principal\.(sessionId|userId)\)/.test(op.body),
      "touches a session table without constraining it to this principal"
    );
    continue;
  }

  check(
    `${op.name} filters on owner_id`,
    op.body.includes("owner_id"),
    `queries ${needsScope.join(", ")} with no owner filter`
  );
}

console.log("\n2b. a stored procedure is scoped too");
// A handler that calls `rpc` touches no table this file can see, so the check
// above waves it through. That is exactly how a hole gets in: `run_save` writes
// three tables and looks, from here, like it writes none. So an rpc call has to
// hand the procedure something from the token.
for (const op of ops) {
  if (!/\.rpc\(/.test(op.body)) continue;
  check(
    `${op.name} passes the principal into the procedure`,
    /principal\.(userId|sessionId|username)/.test(op.body),
    "an rpc that takes no identity is an rpc the database cannot scope"
  );
}

console.log("\n3. the owner is taken from the token, never the request");
for (const op of ops) {
  if (!op.body.includes("owner_id:")) continue;
  check(
    `${op.name} writes principal.userId as the owner`,
    /owner_id:\s*principal\.userId/.test(op.body),
    "an owner_id written from anywhere but the token lets a caller plant a row in another account"
  );
}
check(
  "no handler reads an owner out of args",
  !/owner_id:\s*args\./.test(src) && !/args\.ownerId/.test(src),
  "args must never name an owner"
);

console.log("\n4. the principal reaches every handler that needs it");
for (const op of ops) {
  if (!op.body.includes("principal")) continue;
  check(
    `${op.name} destructures principal`,
    /async \(\{[^}]*principal[^}]*\}/.test(op.body),
    "uses principal without taking it from the context"
  );
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall tenancy checks passed\n");
process.exit(fail ? 1 : 0);
