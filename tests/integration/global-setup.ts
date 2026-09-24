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
  if (!existsSync(link) && !isSymlink(link)) {
    // Windows 的目录 symlink 需要开发者模式/管理员权限；junction 不需要，
    // 但要求目标是绝对路径（相对路径的 junction 行为不可靠）。
    if (process.platform === 'win32') symlinkSync(root, link, 'junction')
    else symlinkSync('../..', link, 'dir')
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}
