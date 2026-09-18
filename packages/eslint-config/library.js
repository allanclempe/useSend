const { resolve } = require("node:path");

const project = resolve(process.cwd(), "tsconfig.json");

/** @type {import("eslint").Linter.Config} */
module.exports = {
  extends: ["eslint:recommended", "prettier"],
  plugins: ["only-warn", "@typescript-eslint"],
  globals: {
    React: true,
    JSX: true,
  },
  env: {
    node: true,
  },
  rules: {
    // The base rule is TypeScript-unaware: it reports names that are only used
    // in type positions (type-only imports, parameters of function types,
    // `declare module` blocks) as unused. Use the TypeScript-aware version.
    // A deliberately unused binding is marked with a leading underscore, the
    // convention this codebase already uses (`_job`, `_target`, `_request`).
    "no-unused-vars": "off",
    "@typescript-eslint/no-unused-vars": [
      "warn",
      {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      },
    ],
  },
  settings: {
    "import/resolver": {
      typescript: {
        project,
      },
    },
  },
  ignorePatterns: [
    // Ignore dotfiles
    ".*.js",
    "node_modules/",
    "dist/",
  ],
  overrides: [
    {
      files: ["*.js?(x)", "*.ts?(x)"],
    },
  ],
};
