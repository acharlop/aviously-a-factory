import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["eslint", "typescript", "oxc", "node"],
  categories: {
    correctness: "error",
  },
});
