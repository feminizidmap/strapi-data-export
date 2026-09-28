import { defineConfig } from 'vitest/config';

/**
 * The harness preset lives in the monorepo and is not installed in a standalone
 * checkout. Unit tests still run; the Strapi-booting suite needs the workspace.
 */
const harnessOptions = async (): Promise<Record<string, unknown>> => {
  try {
    const preset = await import('@qkix/strapi-test-harness/vitest-preset');
    return preset.strapiTestOptions ?? {};
  } catch {
    return {};
  }
};

export default defineConfig(async () => ({
  test: {
    environment: 'node',
    // Covers tests/integration, which boots a real Strapi - see
    // tooling/strapi-test-harness.
    include: ['server/src/**/*.test.ts', 'tests/**/*.test.ts'],
    ...(await harnessOptions()),
  },
}));
