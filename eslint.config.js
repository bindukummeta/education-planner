"use strict";

const js = require("@eslint/js");
const globals = require("globals");

// Names this app attaches to window from plain scripts. Declared here so
// no-undef stays on without pretending every identifier is global.
const appGlobals = {
  EduStore: "readonly",
  EduSync: "readonly",
  EduPrivacy: "readonly",
  EduPublicConfig: "readonly",
  EduClientReport: "readonly",
  EduReportPolicy: "readonly",
  // UMD wrappers assign module.exports when Node loads the same file.
  module: "readonly",
};

const rules = Object.assign({}, js.configs.recommended.rules, {
  "no-eval": "error",
  "no-implied-eval": "error",
  "no-new-func": "error",
  "no-script-url": "error",
  "no-extend-native": "error",
  eqeqeq: ["error", "smart"],
  // Existing fail-soft catches and regexes. Unused UI helpers are not a
  // security finding; no-undef and the rules above are the gate.
  "no-empty": "off",
  "no-useless-escape": "off",
  "no-useless-catch": "off",
  "no-unused-vars": "off",
  "no-useless-assignment": "off",
  "preserve-caught-error": "off",
});

module.exports = [
  {
    ignores: ["vendor/**", "node_modules/**", "playwright-report/**", "test-results/**", "blob-report/**"],
  },
  {
    files: ["api/**/*.js", "scripts/**/*.js", "eslint.config.js", "playwright.config.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: Object.assign({}, globals.node),
    },
    rules: rules,
  },
  {
    files: ["test/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: Object.assign({}, globals.node, globals.browser),
    },
    rules: rules,
  },
  {
    files: ["*.js"],
    ignores: ["api/**", "scripts/**", "test/**", "eslint.config.js", "playwright.config.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: Object.assign({}, globals.browser, globals.serviceworker, appGlobals),
    },
    rules: rules,
  },
];
