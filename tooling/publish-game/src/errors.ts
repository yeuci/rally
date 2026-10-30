/** A user-facing failure: the CLI prints the message (no stack) and exits 1. */
export class PublishError extends Error {
  override readonly name = 'PublishError';
}
