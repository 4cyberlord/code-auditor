import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

// eslint-config-next ships native flat config from 16 onwards, so the
// @eslint/eslintrc FlatCompat shim these were loaded through is gone. Going
// through it now throws a circular-reference error while validating the config,
// because the shim re-serializes a config that already references itself.
const config = [
  {
    // supabase/functions is Deno, not Next: different globals, different module
    // resolution. Linting it with this config reports problems that are not.
    ignores: [".next/**", "out/**", "src-tauri/**", "supabase/functions/**", "node_modules/**", "next-env.d.ts"],
  },
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    // Two rules arrived with the react-hooks plugin in eslint-config-next 16
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
    },
  },
];

export default config;
