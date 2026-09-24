import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const kitSrc = fileURLToPath(new URL('../src/', import.meta.url))

export default defineConfig({
  resolve: {
    // 与 tsconfig.json 的 paths 一致：测试直接对着基础包源码
    alias: [
      { find: /^@mc\/dsh-agent-kit$/, replacement: `${kitSrc}index.ts` },
      { find: /^@mc\/dsh-agent-kit\/(ws|dingtalk|feishu|notify|agent-tasks|jev|secrets|testing)$/, replacement: `${kitSrc}$1/index.ts` },
    ],
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx', 'tests/integration/**/*.test.ts'],
    testTimeout: 20_000,
    globalSetup: ['tests/integration/global-setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/**/index.ts', 'src/**/index.tsx'],
      thresholds: { lines: 80, branches: 70 },
    },
  },
})
