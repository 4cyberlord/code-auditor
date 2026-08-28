import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  {
    // supabase/functions is Deno, not Next: different globals, different module
    // resolution. Linting it with this config reports problems that are not.
    ignores: [".next/**", "out/**", "src-tauri/**", "supabase/functions/**", "node_modules/**", "next-env.d.ts"],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
];

export default config;
