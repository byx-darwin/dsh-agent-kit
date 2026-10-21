import { KitError, type KitErrorOptions } from '../common/errors.js'

export type NotifyErrorCode = 'channel_unavailable' | 'invalid_channel' | 'login_unsupported' | 'send_failed'

export class NotifyError extends KitError {
  declare readonly code: NotifyErrorCode

  constructor(code: NotifyErrorCode, message: string, options: KitErrorOptions = {}) {
    super('notify', code, message, options)
    this.name = 'NotifyError'
  }
}
