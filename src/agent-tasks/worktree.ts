import { execFile } from 'node:child_process'
import { mkdir, realpath, rmdir } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface TaskWorktree {
  repository: string
  path: string
  branch: string
}

function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** 只接受业务插件指定的、干净的 Git 仓库根目录；从 HEAD 建独立分支，不复制未提交改动。 */
export async function createTaskWorktree(repository: string, workspaceDir: string, taskDir: string, taskId: string, signal: AbortSignal): Promise<TaskWorktree> {
  if (!isAbsolute(repository)) throw new Error('worktree.repository must be an absolute path')
  const root = await realpath(repository)
  const workspace = await realpath(workspaceDir)
  if (contains(root, workspace) || contains(workspace, root)) throw new Error('task workspace and source repository must be separate directories')
  const command = (args: string[]) => execFileAsync('git', ['-C', root, ...args], { signal, maxBuffer: 64 * 1024 })
  const top = (await command(['rev-parse', '--show-toplevel'])).stdout.trim()
  if (await realpath(top) !== root) throw new Error('worktree.repository must be a Git repository root')
  const dirty = (await command(['status', '--porcelain=v1', '--untracked-files=normal'])).stdout.trim()
  if (dirty) throw new Error('source repository has uncommitted or untracked changes; commit, stash, or clean it before creating a task worktree')
  const branch = `agent-kit/task-${taskId}`
  // Git 默认按进程 umask 创建目录；先建 0700 空目录，防止私有代码短暂暴露给同机其他用户。
  await mkdir(taskDir, { mode: 0o700 })
  try {
    await command(['worktree', 'add', '-b', branch, taskDir, 'HEAD'])
  } catch (error) {
    // 只清理仍为空的占位目录；Git 若已写入内容，保留现场供排查。
    await rmdir(taskDir).catch(() => {})
    throw error
  }
  return { repository: root, path: taskDir, branch }
}
