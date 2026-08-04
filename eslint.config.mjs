// Flat config. Type-aware rules, because the mistakes worth catching here (a floating promise
// around a tmux round trip, an unawaited write) are invisible without types.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules", "dist", ".pnpm-store"] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The .mjs files here (this config, scripts/) are outside the TypeScript project, so the
    // type-aware rules have nothing to work from. Node's globals are declared by hand rather
    // than by taking a `globals` package for four names.
    files: ["**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: {
        process: "readonly",
        console: "readonly",
        URL: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
      },
    },
  },
);
