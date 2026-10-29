import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["node_modules/", ".wrangler/", "dist/", "coverage/"] },
  js.configs.recommended,
  tseslint.configs.strict,
  tseslint.configs.stylistic,
  {
    // The panel's script runs in the browser as a classic script, without a bundler.
    files: ["public/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        document: "readonly",
        window: "readonly",
        location: "readonly",
        navigator: "readonly",
        fetch: "readonly",
        confirm: "readonly",
        prompt: "readonly",
        alert: "readonly",
        setTimeout: "readonly",
        Element: "readonly",
        HTMLFormElement: "readonly",
        HTMLInputElement: "readonly",
        encodeURIComponent: "readonly",
        crypto: "readonly",
        btoa: "readonly",
        Uint8Array: "readonly",
        Blob: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
);
