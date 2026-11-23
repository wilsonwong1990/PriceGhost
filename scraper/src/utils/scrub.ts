/**
 * Credential scrubbing for scraper logs.
 *
 * The canonical implementation is
 * `backend/src/utils/system/logging/scrubber.ts`, which the backend's logger
 * applies to everything it writes. The scraper is a separate container with
 * its own `console`-based logger and cannot import across the workspace
 * boundary, so this is the same expression kept deliberately in step with it.
 *
 * It matters here because the one credential this service handles is the proxy
 * URL, and `http://user:pass@host:port` is the normal shape of it.
 */
export const scrubUrlCredentials = (value: string): string =>
  value.replace(/(https?:\/\/)([^/?#\s]*@)/gi, (_match, scheme: string, userinfo: string) =>
    `${scheme}${userinfo.includes(':') ? '[REDACTED]:[REDACTED]' : '[REDACTED]'}@`
  );

export function scrubLogMetadata(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return scrubUrlCredentials(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (value instanceof Error) {
    return { name: value.name, message: scrubUrlCredentials(value.message), stack: value.stack && scrubUrlCredentials(value.stack) };
  }
  if (Array.isArray(value)) return value.map(item => scrubLogMetadata(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /password|token|secret|authorization|cookie|body|postdata/i.test(key)
      ? '[REDACTED]'
      : scrubLogMetadata(item, seen),
  ]));
}
