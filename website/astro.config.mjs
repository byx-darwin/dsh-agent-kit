import { defineConfig } from 'astro/config'
import mdx from '@astrojs/mdx'
import sitemap from '@astrojs/sitemap'
import { fileURLToPath } from 'node:url'

// 项目站：https://byx-darwin.github.io/dsh-agent-kit/
export default defineConfig({
  site: 'https://byx-darwin.github.io/dsh-agent-kit',
  base: '/dsh-agent-kit',
  integrations: [mdx(), sitemap()],
  vite: {
    // 构建期导入仓库根的 src/（配置 schema）与 package.json
    server: { fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] } },
  },
})
