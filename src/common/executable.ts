import { accessSync, constants, existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/**
 * npm 全局安装后，Windows 上 PATH 目录里的是一个 `<name>.cmd` shim（Node 用 shell:false 无法直接
 * spawn），真正的入口是包里的 Node 脚本。这里登记本包会调用的 CLI 在 npm 包中的入口位置。
 */
const WINDOWS_SHIM_SCRIPTS: Record<string, string> = {
  dws: join('dingtalk-workspace-cli', 'bin', 'dws.js'),
  'lark-cli': join('@larksuite', 'cli', 'scripts', 'run.js'),
}

function resolveWindowsCmdShim(dir: string, name: string): string | undefined {
  const script = join(dir, 'node_modules', WINDOWS_SHIM_SCRIPTS[name] ?? join(name, 'bin', `${name}.js`))
  return existsSync(script) ? script : undefined
}

export function resolveExecutable(name: string, envPath = process.env.PATH ?? '', platform: NodeJS.Platform = process.platform): string | undefined {
  // PATH 分隔符本身按 platform 参数选择（便于在非 Windows 主机上测试 Windows 分支）；
  // 实际的路径拼接与判等仍用当前宿主 OS 的 node:path 语义（真实 Windows 上二者一致）。
  const pathDelimiter = platform === 'win32' ? ';' : ':'
  for (const dir of envPath.split(pathDelimiter)) {
    if (!dir || !isAbsolute(dir)) continue
    if (platform === 'win32') {
      const exe = join(dir, `${name}.exe`)
      if (existsSync(exe)) return exe
      if (existsSync(join(dir, `${name}.cmd`))) {
        const script = resolveWindowsCmdShim(dir, name)
        if (script) return script
      }
      continue
    }
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // 继续查找
    }
  }
  return undefined
}
