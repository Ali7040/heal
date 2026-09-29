import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts'],
    // No network, no model calls in the suite (AGENTS.md — testing expectations).
    // Anything needing a live harness belongs in an explicit integration script.
    environment: 'node',
    // The safety tests drive real git in real repositories, on purpose. A heal is
    // now a commit (D-023), and on Windows each git call is a process spawn: a
    // two-run journal test takes ~3s alone and brushes 5s under a loaded suite.
    testTimeout: 20_000,
  },
});
