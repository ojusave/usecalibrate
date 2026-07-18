import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/** The wall: packages/kit must never import from apps/demo. */
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "examples/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["packages/kit/**/*.{js,mjs,cjs,ts}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/apps/demo/**", "@firstmile/demo", "apps/demo", "*/apps/demo/*"],
              message:
                "packages/kit must stay product-agnostic: do not import from apps/demo.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["scripts/**/*.{js,mjs,cjs,ts}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.node,
    },
  },
  {
    files: ["apps/demo/public/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.browser,
    },
  }
);
