/** The device a write discards: nothing written to it reaches any file. */
const DISCARD_DEVICE = "/dev/null";

/**
 * Paths that are universally safe and should never trigger external-directory checks.
 * These are OS device files: read returns EOF or process streams, write discards or goes to process streams.
 */
export const SAFE_SYSTEM_PATHS: ReadonlySet<string> = new Set([
  DISCARD_DEVICE,
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
]);

/**
 * Returns true if the given normalized path is a safe OS device file
 * that should never trigger external-directory checks.
 */
export function isSafeSystemPath(normalizedPath: string): boolean {
  return SAFE_SYSTEM_PATHS.has(normalizedPath);
}

/**
 * Returns true only for the discard device, `/dev/null`, so a write to `path`
 * touches no file.
 *
 * Narrower than {@link isSafeSystemPath}: on Linux, `/dev/std{in,out,err}`
 * link to `/proc/self/fd/N`, and opening one for writing reopens the
 * descriptor's underlying file with `O_TRUNC` — `cat < f > /dev/stdin`
 * truncates `f`.
 */
export function isDiscardDevice(path: string): boolean {
  return path === DISCARD_DEVICE;
}
