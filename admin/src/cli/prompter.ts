import { checkbox, confirm, input, password, select } from '@inquirer/prompts'

export interface Prompter {
  select<T extends string>(message: string, choices: { value: T; name: string; description?: string }[], def?: T): Promise<T>
  checkbox<T extends string>(message: string, choices: { value: T; name: string; checked?: boolean }[]): Promise<T[]>
  input(message: string, def?: string, validate?: (v: string) => true | string): Promise<string>
  password(message: string): Promise<string>
  confirm(message: string, def?: boolean): Promise<boolean>
}

export const inquirerPrompter: Prompter = {
  select: (message, choices, def) => select({ message, choices, ...(def ? { default: def } : {}) }),
  checkbox: (message, choices) => checkbox({ message, choices }),
  input: (message, def, validate) => input({ message, ...(def !== undefined ? { default: def } : {}), ...(validate ? { validate } : {}) }),
  password: (message) => password({ message, mask: '*' }),
  confirm: (message, def) => confirm({ message, default: def ?? true }),
}

/** 测试用：按调用顺序依次返回答案；input 的答案不通过 validate 时抛错。 */
export function scriptedPrompter(answers: unknown[]): Prompter & { remaining(): number } {
  const queue = [...answers]
  const next = (message: string) => {
    if (queue.length === 0) throw new Error(`scriptedPrompter: no answer for "${message}"`)
    return queue.shift()
  }
  return {
    remaining: () => queue.length,
    select: async (m) => next(m) as never,
    checkbox: async (m) => next(m) as never,
    input: async (m, _def, validate) => {
      const v = next(m) as string
      const ok = validate?.(v) ?? true
      if (ok !== true) throw new Error(`scriptedPrompter: invalid answer for "${m}": ${ok}`)
      return v
    },
    password: async (m) => next(m) as string,
    confirm: async (m) => next(m) as boolean,
  }
}
