import { KitError, type KitErrorOptions } from '../common/errors.js'

export type DingtalkErrorCode = 'timeout' | 'exit_nonzero' | 'bad_output' | 'invalid_target' | 'send_failed' | 'aborted' | 'spawn_failed'

export class DingtalkSendError extends KitError {
  declare readonly code: DingtalkErrorCode

  constructor(code: DingtalkErrorCode, message: string, options: KitErrorOptions = {}) {
    super('dingtalk', code, message, { retryable: options.retryable ?? code === 'timeout', ...options })
    this.name = 'DingtalkSendError'
  }
}
