import { KitError } from '../common/errors.js'
import type { FieldError } from './kit-entries.js'

export type ProfileErrorCode = 'conflict' | 'invalid_config' | 'unsupported_yaml' | 'parse_error' | 'profile_not_found'

export class ProfileError extends KitError {
  constructor(code: ProfileErrorCode, message: string, details?: { errors?: FieldError[]; line?: number }) {
    super('kit', code, message, { retryable: code === 'conflict', details })
    this.name = 'ProfileError'
  }
}
