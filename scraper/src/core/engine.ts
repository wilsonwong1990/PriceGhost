/**
 * Which browser engine serves a scrape, and how Firefox is configured.
 *
 * Chromium stays the default. Firefox exists for retailers whose bot manager
 * scores headless Chromium itself rather than the request: on those, a page
 * that walls every Chromium build may still load in headless Firefox. That is
 * not guaranteed, since Firefox reports navigator.webdriver as true and IP
 * reputation still applies.
 * Firefox is driven over WebDriver BiDi, which has no equivalent for the
 * Chromium-only parts of the stack (the stealth and ad-blocker plugins, CDP
 * User-Agent and client-hint overrides), so its identity is set with
 * preferences at launch instead and those helpers live here, free of
 * Puppeteer, so they are testable without launching a browser.
 */

import { parseUserAgent } from '../utils/userAgent.js';
import { scrubUrlCredentials } from '../utils/scrub.js';

export const BROWSER_ENGINES = ['chromium', 'firefox'] as const;
export type BrowserEngine = (typeof BROWSER_ENGINES)[number];
export const DEFAULT_BROWSER_ENGINE: BrowserEngine = 'chromium';

/**
 * The engine a request asked for: the default when it named none, null when
 * it named one this scraper does not have (the route answers that with 400).
 */
export function resolveBrowserEngine(value: unknown): BrowserEngine | null {
  if (value === undefined || value === null) return DEFAULT_BROWSER_ENGINE;
  return (BROWSER_ENGINES as readonly unknown[]).includes(value) ? (value as BrowserEngine) : null;
}

/**
 * A browser could not be launched at all, as opposed to the pool being full.
 *
 * The pool-full case is answered with 503 and retried by the backend; this one
 * is not, because retrying cannot install a missing browser.
 */
export class BrowserLaunchError extends Error {
  readonly engine: BrowserEngine;

  constructor(engine: BrowserEngine, cause: unknown) {
    const reason = scrubUrlCredentials(cause instanceof Error ? cause.message : String(cause));
    super(`Could not launch ${engine}: ${reason}`);
    this.name = 'BrowserLaunchError';
    this.engine = engine;
  }
}

/**
 * Whether Firefox should present the configured User-Agent.
 *
 * Only a Firefox UA is applied. Sending a Chrome UA from Gecko would contradict
 * every other signal the page can read (no `window.chrome`, Gecko-only APIs,
 * no client hints) and is a stronger bot tell than Firefox's own UA.
 */
export function shouldApplyUserAgentToFirefox(userAgent: string | null | undefined): userAgent is string {
  if (!userAgent) return false;
  return parseUserAgent(userAgent).family === 'firefox';
}

type FirefoxPrefValue = string | number | boolean;

const SOCKS_SCHEMES: Record<string, 4 | 5> = { 'socks:': 5, 'socks5:': 5, 'socks5h:': 5, 'socks4:': 4 };
const DEFAULT_PROXY_PORT: Record<string, number> = { 'http:': 80, 'socks:': 1080, 'socks4:': 1080, 'socks5:': 1080, 'socks5h:': 1080 };

/**
 * Proxy preferences equivalent to Chromium's `--proxy-server=<url>`.
 *
 * Firefox takes a proxy as host/port preferences, not a URL. Like the Chromium
 * path, credentials embedded in the URL are not applied; an IP-allowlisted
 * proxy is what works with either engine. An `https://` proxy (TLS to the
 * proxy itself) has no preference equivalent and is refused rather than
 * silently downgraded to plain HTTP.
 */
export function firefoxProxyPrefs(proxyUrl: string): Record<string, FirefoxPrefValue> {
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    throw new Error('Firefox engine: the proxy URL could not be parsed');
  }

  const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
  if (!host) throw new Error('Firefox engine: the proxy URL has no host');
  const port = parsed.port ? Number(parsed.port) : DEFAULT_PROXY_PORT[parsed.protocol];

  if (parsed.protocol === 'http:') {
    return {
      'network.proxy.type': 1,
      'network.proxy.http': host,
      'network.proxy.http_port': port,
      'network.proxy.ssl': host,
      'network.proxy.ssl_port': port,
      'network.proxy.no_proxies_on': '',
    };
  }

  const socksVersion = SOCKS_SCHEMES[parsed.protocol];
  if (socksVersion) {
    return {
      'network.proxy.type': 1,
      'network.proxy.socks': host,
      'network.proxy.socks_port': port,
      'network.proxy.socks_version': socksVersion,
      'network.proxy.socks_remote_dns': socksVersion === 5,
      'network.proxy.no_proxies_on': '',
    };
  }

  throw new Error(`Firefox engine: ${parsed.protocol}// proxies are not supported; use http:// or socks5://`);
}

/** Preferences a Firefox session is launched with. */
export function buildFirefoxPrefs(
  proxyUrl: string | null,
  userAgent: string | null
): Record<string, FirefoxPrefValue> {
  return {
    ...(proxyUrl ? firefoxProxyPrefs(proxyUrl) : {}),
    ...(shouldApplyUserAgentToFirefox(userAgent) ? { 'general.useragent.override': userAgent } : {}),
  };
}
