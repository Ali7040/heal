import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts'],
    // No network, no model calls in the suite (AGENTS.md — testing expectations).
    // Anything needing a live harness belongs in an explicit integration script.
    environment: 'node',
  },
});
