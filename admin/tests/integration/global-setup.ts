import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 集成测试通过包名加载已构建的 lib/（基础包与本包），模拟 dsh plugin add 后的安装形态。
export default function setup() {
  const admin = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const root = resolve(admin, '..')
  const tsc = join(root, 'node_modules/typescript/bin/tsc')
  execFileSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.build.json')], { stdio: 'inherit' })
  execFileSync(process.execPath, [tsc, '-p', join(admin, 'tsconfig.build.json')], { stdio: 'inherit' })
  link(join(root, 'node_modules/@mc/dsh-agent-kit'), root, '../..')
  link(join(root, 'node_modules/@mc/dsh-agent-kit-admin'), admin, '../../admin')
}

function link(path: string, target: string, relative: string): void {
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path) || isSymlink(path)) return
  // Windows 的目录 symlink 需要开发者模式/管理员权限；junction 不需要，但要求绝对路径
  if (process.platform === 'win32') symlinkSync(target, path, 'junction')
  else symlinkSync(relative, path, 'dir')
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}
