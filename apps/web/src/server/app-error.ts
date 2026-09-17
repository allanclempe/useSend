/**
 * The error a server function throws when it refuses.
 *
 * TanStack Start serialises a thrown `Error` back to the caller, so the
 * **message** is what reaches the browser and lands in the toast the component
 * already shows — the same thing `TRPCError`'s message did. Nothing in the
 * dashboard branches on an error code today, and this does not invite it to
 * start: `code` is for the server's own use, in logs and in the one place that
 * still has to produce an HTTP status.
 *
 * It is deliberately not a status number at the throw site. A server function
 * is an RPC call that happens to travel over HTTP, and the transport has
 * usually already answered 200 by the time the client reads the error. The
 * public API has its own `UnsendApiError` and is untouched by any of this.
 */
export type AppErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "CONFLICT";

export class AppError extends Error {
  readonly code: AppErrorCode;

  constructor(code: AppErrorCode, message?: string, options?: ErrorOptions) {
    super(message ?? code, options);
    this.name = "AppError";
    this.code = code;
  }
}

export const unauthorized = (message?: string) =>
  new AppError("UNAUTHORIZED", message);
export const forbidden = (message?: string) =>
  new AppError("FORBIDDEN", message);
export const notFound = (message?: string) => new AppError("NOT_FOUND", message);
export const badRequest = (message?: string) =>
  new AppError("BAD_REQUEST", message);
export const conflict = (message?: string) => new AppError("CONFLICT", message);
