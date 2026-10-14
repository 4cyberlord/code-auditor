import { strict as assert } from "node:assert";
import { SCREENSHOT_BUCKET, validateScreenshotUploadKey as validate } from "../supabase/functions/council-editor-api/storagePolicy.ts";
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const session = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const submission = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const standard = `${owner}/${session}/capture.png`;
const durable = `${owner}/${session}/${submission}/0-capture.png`;
assert.equal(SCREENSHOT_BUCKET, "screenshots");
assert.equal(validate(owner,standard,"screenshots"),null);
assert.equal(validate(owner,durable,"screenshots"),null);
for(const [path,bucket] of [
  [standard,"other-bucket"],
  [`zzzz/${session}/capture.png`,"screenshots"],
  [`${owner}/../capture.png`,"screenshots"],
  [`${owner}/${session}/../capture.png`,"screenshots"],
  [`${owner}/${session}/${submission}/99-capture.png`,"screenshots"],
  [`${owner}/${session}/foo/bar.png`,"screenshots"],
  [`${owner}/${session}/capture%2Fescape.png`,"screenshots"],
  [`${owner}/${session}/capture?.png`,"screenshots"],
]) assert.ok(validate(owner,path,bucket), `Must reject ${path} ${bucket}`);
console.log("Screenshot upload policy checks passed");
