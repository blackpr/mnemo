import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppError } from "./handlers.js";

export type { AppError };

/**
 * Maps application-layer Result errors to HTTP. Attachment owns this table; the application
 * layer knows nothing about HTTP. Unknown kinds become 500 without leaking details.
 */
export interface HttpError {
  readonly status: ContentfulStatusCode;
  readonly body: { readonly error: string; readonly detail?: unknown };
}

export function toHttpError(err: AppError): HttpError {
  const error = err as AppError & Record<string, unknown>;
  switch (error.kind) {
    case "Unauthorized":
      return { status: 401, body: { error: "unauthorized" } };
    case "NoGrant":
    case "AccessDenied":
      return { status: 403, body: { error: "forbidden" } };
    case "BankNotFound":
      return { status: 404, body: { error: "bank_not_found" } };
    case "FactNotFound":
      return { status: 404, body: { error: "fact_not_found", detail: { factId: error["factId"] } } };
    case "EpisodeNotFound":
      return { status: 422, body: { error: "episode_not_found", detail: { episodeId: error["episodeId"] } } };
    case "ErasureNotFound":
      return { status: 404, body: { error: "erasure_not_found", detail: { requestId: error["requestId"] } } };
    case "ErasureInFlight":
      return { status: 409, body: { error: "erasure_in_flight" } };
    case "EngineMismatch":
      // A server-side wiring fault the caller cannot fix; which engines are deployed stays out of the response.
      return { status: 409, body: { error: "engine_mismatch" } };
    case "ErasureTerminal":
    case "ErasureStillRunning":
      return { status: 409, body: { error: "erasure_not_abandonable", detail: error } };
    case "BankNotWritable":
      return { status: 409, body: { error: "bank_not_writable" } };
    case "DuplicateEpisode":
      return { status: 409, body: { error: "duplicate_episode", detail: { episodeId: error["episodeId"] } } };
    case "DuplicateFact":
      return { status: 409, body: { error: "duplicate_fact", detail: { factId: error["factId"] } } };
    case "AlreadyRetracted":
      return { status: 409, body: { error: "fact_retracted", detail: { factId: error["factId"] } } };
    case "AlreadySuperseded":
      return { status: 409, body: { error: "fact_superseded", detail: { factId: error["factId"], by: error["by"] } } };
    case "NoProvenance":
    case "InvalidValidity":
    case "BankMismatch":
    case "SelfSupersession":
      return { status: 400, body: { error: "invalid_fact", detail: error } };
    default:
      return { status: 500, body: { error: "internal" } };
  }
}
