import { strict as assert } from "node:assert";
import { parseSymbolicBound, compareComplexityBounds, canonicalComplexityBound,
  solvePolynomialMaster } from "../src/lib/theoryBounds.ts";
const relation=(a:string,b:string)=>compareComplexityBounds(a,b).relation;

assert.equal(relation("O(n)","O(n^2)"),"left-no-worse");
assert.equal(relation("O(n log n)","O(n^2)"),"left-no-worse");
assert.equal(relation("O(n sqrt n)","O(n^2)"),"left-no-worse");
assert.equal(relation("O(log² n)","O(n)"),"left-no-worse");
assert.equal(relation("O(log^2(n))","O(n)"),"left-no-worse");
assert.equal(relation("O(alpha(n))","O(log n)"),"left-no-worse");
assert.equal(relation("O(2^n)","O(n!)"),"left-no-worse");
assert.equal(relation("O(V+E)","O(V+E log V)"),"left-no-worse");
assert.equal(relation("O(n + m)","O(n*m)"),"left-no-worse");
assert.equal(relation("O(n^2+m)","O(n+m^2)"),"incomparable");
assert.equal(relation("O(V+E)","O(V^2)"),"incomparable",
  "independent vertex/edge dimensions must not be collapsed");
assert.equal(relation("O(n)","O(m)"),"incomparable");
assert.equal(relation("O(n+m)","O(m+n)"),"equivalent");
assert.equal(relation("O((n+m)*log n)","O(n log n+m log n)"),"equivalent");
assert.equal(relation("O(n+m)","O(n+m)"),"equivalent");
assert.equal(relation("O(n^2)","O(n)"),"right-no-worse");
assert.equal(relation("Omega(n)","O(n)"),"unknown",
  "a lower bound is not interchangeable with a cost upper bound");
assert.equal(relation("O(n^k)","O(n^2)"),"unknown",
  "unknown exponent k must not be silently instantiated");
assert.equal(relation("O(log(n+m))","O(n)"),"unknown",
  "unsupported compound logarithms must yield unknown");
assert.equal(relation("O(n - m)","O(n)"),"unknown");
assert.equal(relation("O(n/m)","O(n)"),"unknown");
assert.equal(relation("O(unknown(n))","O(n)"),"unknown");
assert.equal(parseSymbolicBound("O(n log n)")?.dimensions.join(","),"n");
assert.equal(canonicalComplexityBound("O(n+m)"),canonicalComplexityBound("O(m+n)"));

const merge=solvePolynomialMaster(2,2,1);
assert.deepEqual({bound:merge?.bound,which:merge?.case},
  {bound:"Theta(n log n)",which:2});
assert.equal(solvePolynomialMaster(8,2,1)?.bound,"Theta(n^3)");
assert.equal(solvePolynomialMaster(2,2,2)?.bound,"Theta(n^2)");
assert.equal(solvePolynomialMaster(2,2,1,2)?.bound,"Theta(n log^3 n)");
assert.equal(solvePolynomialMaster(2,1,1),null);
assert.equal(solvePolynomialMaster(2,2,-1),null);
console.log("PASS: symbolic multivariate bounds and limited Master theorem, with safe abstention");
