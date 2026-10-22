import { defineConfig } from "oxlint";

export default defineConfig({
  ignorePatterns: [".claude/worktrees/**"],
  plugins: ["eslint", "typescript", "oxc", "node"],
  categories: {
    correctness: "error",
  },
});
