import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // The engine and server share one test database and one Prisma singleton.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
