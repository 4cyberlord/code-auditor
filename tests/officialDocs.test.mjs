import assert from "node:assert/strict";
import { clearOfficialDocsCache, fetchOfficialDocDigest, searchTerms } from "../scripts/lib/officialDocs.mjs";

assert.deepEqual(searchTerms("sort sort and sorting, 12345; __proto__;"), ["sort", "sorting", "proto"]);
clearOfficialDocsCache();
const environment = {
  CODE_AUDITOR_LANGUAGE_REGISTRIES: JSON.stringify([
    { id: "neon", url: "https://docs.example.org/rest/v1/", tokenEnv: "DOCS_TOKEN" }
  ]),
  DOCS_TOKEN: "test-token",
};
let requests = 0;
const fetchImpl = async (url, opts) => {
  requests += 1;
  assert.ok(url.includes("/official_doc_topics?"));
  assert.ok(url.includes("language=eq.python"));
  assert.ok(url.includes("content_format=eq.markdown"));
  assert.equal(opts.headers.Authorization, "Bearer test-token");
  return {
    ok: true, headers: new Headers(),
    text: async () => JSON.stringify([{
      title: "Sorting HOWTO",
      content_md: "# Sorting\nUse sorted() for a new list.",
      official_url: "https://docs.python.org/3.15/howto/sorting.html"
    }])
  };
};
const [a,b] = await Promise.all([
  fetchOfficialDocDigest("python", "sorting array", { environment, fetchImpl }),
  fetchOfficialDocDigest("python", "sorting array", { environment, fetchImpl })
]);
assert.equal(a,b);
assert.match(a,/Sorting HOWTO/);
assert.equal(requests,1,"concurrent queries must coalesce");
const c=await fetchOfficialDocDigest("python","sorting array",{environment,fetchImpl});
assert.equal(c,a);
assert.equal(requests,1,"cached queries must not re-fetch");
assert.equal(await fetchOfficialDocDigest("javascript","sorting array",{environment,fetchImpl}),"");
assert.equal(requests,1,"unsupported languages must not reach registry");
clearOfficialDocsCache();
const down=await fetchOfficialDocDigest("rust","borrow checker",{
  environment,fetchImpl:async()=>{throw Error("offline")}
});
assert.equal(down,"","offline registry must not fail solving");
console.log("PASS: official docs retrieval, coalescing, cache, filters and offline fallback");
