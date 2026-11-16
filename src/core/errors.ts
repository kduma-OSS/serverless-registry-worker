/** Error codes of the `/api/v1` error body (docs/api.md section 4). */
export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "version_exists"
  | "upload_mismatch"
  | "artifact_mismatch"
  | "version_changed"
  | "upload_incomplete"
  | "version_closed"
  | "file_exists"
  | "credential_exists"
  | "ambiguous"
  | "payload_too_large"
  | "client_too_old"
  | "rate_limited"
  | "internal_error"
  | "provider_unavailable"
  | "bucket_mismatch";

/** HTTP status of every error code. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  version_exists: 409,
  upload_mismatch: 409,
  artifact_mismatch: 409,
  version_changed: 409,
  upload_incomplete: 400,
  version_closed: 409,
  file_exists: 409,
  credential_exists: 409,
  ambiguous: 409,
  payload_too_large: 413,
  client_too_old: 426,
  rate_limited: 429,
  internal_error: 500,
  provider_unavailable: 503,
  bucket_mismatch: 503,
};

const DEFAULT_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  invalid_request: "Invalid request.",
  unauthorized: "Authentication required.",
  forbidden: "Forbidden.",
  not_found: "Not found.",
  version_exists: "This version is already published.",
  upload_mismatch: "The uploaded object does not match the declaration.",
  artifact_mismatch: "The stored artifact does not match its declared size or SHA-256.",
  version_changed: "The version changed while its digests were being computed; try again.",
  upload_incomplete: "A declared file has not been uploaded.",
  version_closed: "Files can no longer be added to this version.",
  file_exists: "A file with this name already exists in this version.",
  credential_exists: "This credential already exists.",
  ambiguous: "The request matches more than one file.",
  payload_too_large: "Payload too large.",
  client_too_old: "This client is too old for the registry.",
  rate_limited: "Too many requests.",
  internal_error: "Internal error.",
  provider_unavailable: "The credential provider is unavailable.",
  bucket_mismatch: "The R2 bucket is not the one this registry used before.",
};

/**
 * An expected failure that maps to an `/api/v1` error response. The message is shown to
 * clients, so it must never contain secrets (tokens, hashes, presigned URLs).
 */
export class ValidationError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /**
   * Extra fields of the error body after `error` and `message` (e.g. the candidate files of
   * `ambiguous`); never secrets either.
   */
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: ErrorCode,
    message: string = DEFAULT_MESSAGES[code],
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    if (details !== undefined) this.details = details;
  }
}
