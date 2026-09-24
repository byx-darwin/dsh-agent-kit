/** 把站内绝对路径拼到 Astro 的部署 base 上。 */
export function withBasePath(base: string, path: string): string {
  const normalizedBase = base === '/' ? '' : base.replace(/\/$/, '')
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${normalizedBase}${normalizedPath}`
}
