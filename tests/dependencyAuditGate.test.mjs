import { assessAudit, UNPATCHED_DEV_ADVISORY } from "../scripts/security/audit-gate.mjs";
const path = name => "node_modules/" + name;
const chain = ["braces","micromatch","fast-glob","@next/eslint-plugin-next","eslint-config-next"];
const report = {vulnerabilities:Object.fromEntries(chain.map(name=>[
  name, {severity:"high",nodes:[path(name)],via:name==="braces"?[{url:"https://github.com/advisories/"+UNPATCHED_DEV_ADVISORY}]:["braces"]}
]))};
const lock = {packages:Object.fromEntries(chain.map(name=>[path(name),{dev:true}]))};
const assert = (name, ok) => { if(!ok) throw Error(name); console.log("PASS:",name); };
assert("unpatched developer-only exception is scoped",assessAudit(report,lock).ok);
assert("new advisories fail",!assessAudit({vulnerabilities:{...report.vulnerabilities,foo:{severity:"high",nodes:["node_modules/foo"],via:[]}}},lock).ok);
assert("production reachability fails",!assessAudit(report,{packages:{...lock.packages,[path("braces")]:{dev:false}}}).ok);
assert("missing advisory fails",!assessAudit({vulnerabilities:{...report.vulnerabilities,braces:{severity:"high",nodes:[path("braces")],via:[]}}},lock).ok);
assert("critical vulnerabilities fail",!assessAudit({vulnerabilities:{...report.vulnerabilities,braces:{...report.vulnerabilities.braces,severity:"critical"}}},lock).ok);
assert("malformed report fails",!assessAudit({},lock).ok);
