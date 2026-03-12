import { defineConfig } from 'vitest/config';

const isCI = !!process.env['CI'];
const isWindows = process.platform === 'win32';

export default defineConfig({
  test: {
    pool: 'forks',
    // Windows has been intermittently unstable with the fork pool under the full suite.
    // Run serially there so `npm test` stays deterministic for the dev launcher.
    maxWorkers: isCI ? 3 : isWindows ? 1 : undefined,
    testTimeout: 30_000,
    hookTimeout: isWindows ? 60_000 : 30_000,
    unstubEnvs: true,
    unstubGlobals: true,
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'examples'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/channels/cli.ts',
        'src/channels/telegram.ts',
        'src/channels/web.ts',
        'src/index.ts',
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        statements: 70,
        branches: 55,
      },
    },
  },
});
