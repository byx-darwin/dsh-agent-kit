export type ExtractResult = { ok: true; value: unknown } | { ok: false; reason: string }

const FENCE = /^(`{3,}|~{3,})[ \t]*([^\s`]*)[^\n]*\n([\s\S]*?)\n?^\1[ \t]*$/gm

/**
 * 从 Agent 最终答案中提取 JSON（provider 不支持原生结构化输出时的兜底）：
 * - 取最后一个标注为 `json` 的代码块；
 * - 没有则取最后一个未标注语言的代码块；
 * - 都没有则把整段答案作为 JSON 解析；
 * - 选中的候选解析失败直接判失败，不回退到更早的代码块；空答案判失败。
 */
export function extractJson(text: string): ExtractResult {
  if (!text.trim()) return { ok: false, reason: 'empty answer' }
  let lastJson: string | undefined
  let lastPlain: string | undefined
  for (const match of text.matchAll(FENCE)) {
    const lang = (match[2] ?? '').toLowerCase()
    const body = match[3] ?? ''
    if (lang === 'json') lastJson = body
    else if (lang === '') lastPlain = body
  }
  const candidate = lastJson ?? lastPlain ?? text
  const source = lastJson !== undefined ? 'json code block' : lastPlain !== undefined ? 'unlabelled code block' : 'whole answer'
  try {
    return { ok: true, value: JSON.parse(candidate) }
  } catch (e) {
    return { ok: false, reason: `failed to parse ${source}: ${(e as Error).message}` }
  }
}
