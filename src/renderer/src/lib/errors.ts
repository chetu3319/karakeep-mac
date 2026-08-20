/**
 * Message out of an unknown throw value, for the inline error banners.
 *
 * A rejected mutation is nearly always an `ApiError` from main carrying the
 * server's status and body, but IPC can also surface a plain string, so
 * this never assumes an Error instance.
 */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
