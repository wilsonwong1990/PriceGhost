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
  value.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/?#]+)@/gi,
    (_match, scheme: string, userinfo: string) => `${scheme}${userinfo.includes(':') ? '[REDACTED]:[REDACTED]' : '[REDACTED]'}@`);
