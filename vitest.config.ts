import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["test/*.test.{js,ts}"],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
