module.exports = {
  env: {
    browser: true,
    es2021: true,
    node: true,
  },
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "prettier",
  ],
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  parserOptions: {
    ecmaVersion: 12,
    sourceType: "module",
    project: ["./tsconfig.eslint.json"],
    tsconfigRootDir: __dirname,
  },
  rules: {
    "no-constant-condition": ["error", { checkLoops: false }],
    "no-use-before-define": [
      "error",
      {
        variables: true,
        functions: false,
        classes: false,
        allowNamedExports: true,
      },
    ],
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/await-thenable": "error",
    // keep pre-v8 behavior: don't flag unused catch params
    "@typescript-eslint/no-unused-vars": ["error", { caughtErrors: "none" }],
  },
  reportUnusedDisableDirectives: true,
  overrides: [
    {
      files: ["tests/*.ts"],
      env: {
        jest: true,
      },
      parserOptions: {
        project: ["./tests/tsconfig.json"],
      },
      rules: {
        "@typescript-eslint/no-floating-promises": "off",
      },
    },
  ],
};
