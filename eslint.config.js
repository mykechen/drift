import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist/**", "model/**", "node_modules/**"] },

  js.configs.recommended,

  // Type-aware rules cover the TypeScript sources only. This config file is
  // outside tsconfig's `include` and linting it with type information would
  // require an inferred project that resolves none of its imports.
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Non-negotiable per CLAUDE.md. If a type genuinely cannot be expressed,
      // leave a TODO explaining the problem rather than reaching for `any`.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/explicit-function-return-type": [
        "error",
        { allowExpressions: true },
      ],
    },
  },

  {
    rules: {
      // Shipped code logs through the `debug()` wrapper, never directly.
      "no-console": "error",
    },
  },

  prettier,
);
