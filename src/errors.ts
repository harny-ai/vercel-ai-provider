/** The memory API answered with an error, or the call never reached it. */
export class HarnyAPIError extends Error {
  /** The API's error code, for example `content-required`, or `network-error` / `rate-limited` / `timeout` from this package. */
  readonly code: string;
  /** HTTP status, or 0 when no answer came back. */
  readonly status: number;
  /** The API's plain-words explanation. */
  readonly debugMessage: string;
  /** Extra data the API attached (for example the ids a delete could not find). */
  readonly data: unknown;
  /** Seconds to wait before retrying, when the API said so (a per-minute limit). */
  readonly retryAfter: number | undefined;
  /** The `X-Request-Id` of the call, to quote when you ask for help. */
  readonly requestId: string | undefined;

  constructor(init: {
    code: string;
    status: number;
    debugMessage: string;
    data?: unknown;
    retryAfter?: number;
    requestId?: string;
    cause?: unknown;
  }) {
    super(`Harny ${init.status || 'network'} ${init.code}: ${init.debugMessage}`, { cause: init.cause });
    this.name = 'HarnyAPIError';
    this.code = init.code;
    this.status = init.status;
    this.debugMessage = init.debugMessage;
    this.data = init.data;
    this.retryAfter = init.retryAfter;
    this.requestId = init.requestId;
  }
}

/** The package was set up in a way that cannot work (no key, no user, a plain-http address). Nothing was sent. */
export class HarnyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnyConfigError';
  }
}
