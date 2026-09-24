// 把 src/client/index.tsx 构建为 dsh 前端模块：CommonJS 函数体 + window.__ModuleLoader__ 外包装。
// dsh 前端只提供下列共享模块，其余依赖必须打包进来。
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHARED = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const result = await build({
  entryPoints: [resolve(ROOT, 'src/client/index.tsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: SHARED,
  write: false,
  minify: false,
  legalComments: 'none',
})
const body = result.outputFiles[0].text
const wrapped = [
  'window.__ModuleLoader__.load({',
  '\tid: "@mc/dsh-agent-kit",',
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  body.replace(/^/gm, '\t\t'),
  '\t\treturn module.exports;',
  '\t}',
  '});',
  '',
].join('\n')
mkdirSync(resolve(ROOT, 'lib'), { recursive: true })
writeFileSync(resolve(ROOT, 'lib/client.js'), wrapped)
