import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import nextPlugin from "@next/eslint-plugin-next";

const config = [
  {
    // supabase/functions is Deno, not Next: different globals, different module
    // resolution. Linting it with this config reports problems that are not.
    ignores: [".next/**", ".kilo/**", "out/**", "src-tauri/**", "supabase/functions/**", "cloudflare/**", "node_modules/**", "next-env.d.ts"],
  },
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    plugins: {
      "@next/next": nextPlugin,
    },
  },
  {
    // Two rules arrived with the React Hooks recommended config in version 7
    // and flag 12 places that predate them — mount-time loads that read
    // localStorage after hydration, and Date.now()/crypto reads during render.
    //
    // They are worth acting on: each set-state-in-effect costs an extra render
    // pass, and the purity hits are what breaks under the React Compiler. But
    // they are existing patterns across eight components, not regressions, and
    // rewriting that much effect logic belongs in its own change where the
    // behaviour can be checked properly — not folded into a version bump. Left
    // visible as warnings so they stay on the list instead of being silenced.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
];

export default config;
