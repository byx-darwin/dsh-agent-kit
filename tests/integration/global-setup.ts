import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 集成测试通过包名加载已构建的 lib/，模拟 dsh plugin add 后的安装形态。
export default function setup() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.build.json')], { stdio: 'inherit' })
  const link = join(root, 'node_modules/@mc/dsh-agent-kit')
  mkdirSync(dirname(link), { recursive: true })
  if (!existsSync(link) && !isSymlink(link)) symlinkSync('../..', link, 'dir')
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}
