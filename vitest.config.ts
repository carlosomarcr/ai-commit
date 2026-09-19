import { defineConfig } from "vitest/config";

export default defineConfig({
  // Git tests chdir into temp repos, which worker threads don't allow.
  test: { pool: "forks" },
});
