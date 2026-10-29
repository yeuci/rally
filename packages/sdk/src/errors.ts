import type { BridgeErrorCode } from '@rally/protocol';

export class RallyError extends Error {
  override readonly name = 'RallyError';
  readonly code: BridgeErrorCode;

  constructor(code: BridgeErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
