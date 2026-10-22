import assert from "node:assert/strict";
import { API_RECIPES, recipesFor, recipePrompt } from "../src/lib/apiRecipes.ts";

for (const recipe of API_RECIPES) {
  assert.ok(["python", "cpp", "rust"].includes(recipe.language), recipe.id);
  assert.match(recipe.source, /^https:\/\/(docs\.python\.org|en\.cppreference\.com|doc\.rust-lang\.org)\//, recipe.id);
  assert.ok(recipe.snippet.trim().length > 0, recipe.id);
}
assert.equal(recipesFor("python").length, API_RECIPES.filter((r) => r.language === "python").length);
assert.equal(recipesFor("go").length, 0);
assert.match(recipePrompt("rust", ["sort"]), /values\.sort\(\)/);
assert.equal(recipePrompt("go"), "");
console.log("PASS: API recipes carry official sources and narrow selection");
