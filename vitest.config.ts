import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Git tests chdir into temp repos, which worker threads don't allow.
    pool: "forks",
    // Real-git integration tests spawn many processes; CI runners (Windows/macOS) can be slow.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
