import pkg from '../../../package.json'

export const RELEASE = {
  version: pkg.version as string,
  /** 发布到 npm 后改为 true，所有「尚未发布」提示随之消失。 */
  published: false,
} as const
