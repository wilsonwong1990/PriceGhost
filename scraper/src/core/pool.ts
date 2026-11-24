/**
 * Choosing which pooled browser serves a request (issue #254).
 *
 * Separated from `SessionManager` so the one rule that matters here -- a
 * session that cannot answer CDP is never handed to the next request -- is
 * testable without launching Chromium.
 */

import type { BrowserSession } from '../types.js';
import type { BrowserEngine } from './engine.js';

export interface PoolMatch {
  proxyUrl: string | null;
  userAgent: string | null;
  browserEngine: BrowserEngine;
  amazonCartOnly?: boolean;
}

export interface PoolLimits {
  maxPagesPerBrowser: number;
  maxScrapesPerBrowser: number;
}

/**
 * Whether a pooled session is a candidate for this request at all, before any
 * liveness probe.
 *
 * Sessions are pooled by `(proxyUrl, userAgent, browserEngine, amazonCartOnly)` because those
 * decide the identity the browser was launched with; none of them can be
 * changed per page.
 */
export function isSessionEligible(
  session: BrowserSession,
  match: PoolMatch,
  limits: PoolLimits
): boolean {
  if (session.tainted) return false;
  if (session.proxyUrl !== match.proxyUrl) return false;
  if (session.userAgent !== match.userAgent) return false;
  if (session.browserEngine !== match.browserEngine) return false;
  if (Boolean(session.amazonCartOnly) !== Boolean(match.amazonCartOnly)) return false;
  if (session.activePages >= limits.maxPagesPerBrowser) return false;
  if (session.totalScrapes >= limits.maxScrapesPerBrowser) return false;
  // A session still launching has no browser yet; the caller awaits its
  // `launchPromise`. One whose transport has already dropped is out.
  if (session.browser && !session.browser.connected) return false;
  return true;
}

export interface FindReusableSessionOptions {
  pool: readonly BrowserSession[];
  match: PoolMatch;
  limits: PoolLimits;
  /** Real CDP round trip; see `core/health.ts`. */
  probe: (session: BrowserSession) => Promise<boolean>;
  /** Called for a candidate that failed the probe, to take it out of service. */
  discard: (session: BrowserSession) => Promise<void> | void;
}

/**
 * Returns the first pooled session that matches the request *and* answers a
 * CDP round trip, discarding any that does not.
 *
 * The pool is copied before iterating because `discard` removes entries from
 * it. No session is returned on the strength of `browser.connected` alone --
 * that flag staying true on a wedged browser is the whole of #254.
 */
export async function findReusableSession(
  options: FindReusableSessionOptions
): Promise<BrowserSession | null> {
  for (const candidate of [...options.pool]) {
    if (!isSessionEligible(candidate, options.match, options.limits)) continue;

    if (candidate.browser && !(await options.probe(candidate))) {
      await options.discard(candidate);
      continue;
    }

    return candidate;
  }
  return null;
}
