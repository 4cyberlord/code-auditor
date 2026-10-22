import assert from "node:assert/strict";
import { HARNESS_REGISTRY, bestTemplate, describeHarnessSupport } from "../src/lib/harnessRegistry.ts";

for (const template of HARNESS_REGISTRY) {
  assert.ok(template.id && template.description);
  assert.ok(template.languages.length > 0, template.id + " needs a language");
  assert.ok(template.materialises.length > 0, template.id + " must say what it can build");
}

assert.equal(bestTemplate("cpp", "callable-vector")?.id, "native.callable-vector");
assert.equal(bestTemplate("python", "stdin")?.id, "stdin.wrapper");
assert.equal(bestTemplate("go", "stdin"), undefined);

assert.equal(describeHarnessSupport("python", true, false).templateId, "python.callable-vector");
assert.equal(describeHarnessSupport("rust", true, false).templateId, "native.callable-vector");
assert.equal(describeHarnessSupport("java", true, false).supported, false);
assert.match(describeHarnessSupport("python", false, false).reason, /no recognizable/);
assert.match(describeHarnessSupport("java", true, false).reason, /no adapter/);

console.log("PASS: certified templates are declared and refusals are explained");
