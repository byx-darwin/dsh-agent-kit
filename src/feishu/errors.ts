import { KitError, type KitErrorOptions } from '../common/errors.js'

export type FeishuErrorCode = 'timeout' | 'exit_nonzero' | 'bad_output' | 'invalid_target' | 'send_failed' | 'aborted' | 'spawn_failed'

export class FeishuSendError extends KitError {
  declare readonly code: FeishuErrorCode

  constructor(code: FeishuErrorCode, message: string, options: KitErrorOptions = {}) {
    super('feishu', code, message, { retryable: options.retryable ?? code === 'timeout', ...options })
    this.name = 'FeishuSendError'
  }
}
