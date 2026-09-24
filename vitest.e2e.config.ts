import { defineConfig } from 'vitest/config'

// 端到端冒烟：需要真实 dws / subagent / Jev 凭据，只在夜间或手动触发时运行。
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 600_000,
  },
})
