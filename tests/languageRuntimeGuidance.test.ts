import { runtimeGuidanceFor } from "../src/lib/languageRuntimeGuidance.ts";

let failures = 0;
const check = (name: string, condition: boolean) => {
  console.log(`  ${condition ? "ok  " : "FAIL"} ${name}`);
  if (!condition) failures++;
};

console.log("\nlanguage runtime guidance");
check("normalizes versioned C++ fences", runtimeGuidanceFor("c++20").includes("C++20"));
check("keeps Python scope rules", runtimeGuidanceFor("python3.11").includes("comprehensions"));
check("keeps TypeScript runtime rules", runtimeGuidanceFor("ts").includes("TypeScript"));
check("does not invent a contract for an unknown runtime", runtimeGuidanceFor("fortran") === "");

process.exit(failures ? 1 : 0);
