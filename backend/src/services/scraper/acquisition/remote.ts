import { logger } from '../../../utils/system/logger';
import { settingsCache } from '../../../utils/cache';
import {
  fetchRemoteHtml,
  fetchRemoteScrape,
  type RemoteScrapeResult,
  PageNotAvailableError,
  resolveUserAgent
} from '../transport';
import { RetailerConfig } from '../../../models';
import { scrubUrlCredentials } from '../../../utils/system/logging/scrubber';

/**
 * What the browser-scraper service is asked for.
 *
 * Typed here rather than passed as an untyped bag so a field cannot be
 * misspelled into silence -- which is how the User-Agent went missing on this
 * path in the first place.
 */
export interface RemoteScraperOptions {
  productId?: number;
  isDiscovery: boolean;
  requestId?: string;
  userAgent: string;
  useProxy?: boolean;
  proxyUrl?: string;
  referrer?: string;
  challengePatterns?: string[];
  delay?: number;
  /**
   * The *total* budget for the scrape, not just `page.goto`. The scraper
   * service splits it across navigation and the post-navigation phase (human
   * actions, hydration delay, challenge auto-resolve, screenshot), so this
   * number is what `transport/remote.ts` sizes its own request timeout against.
   */
  timeout?: number;
  /** Per-attempt wait while a challenge interstitial auto-resolves (issue #235). */
  interstitialWaitMs?: number;
  /** How many auto-resolve attempts to make before returning the wall (issue #235). */
  interstitialRetries?: number;
  amazonCartMode?: 'auto' | 'required';
}

export interface RemoteAcquisitionOptions {
  url: string;
  domain: string;
  domainConfig?: RetailerConfig;
  productId?: number;
  extractionSteps: string[];
  requestId?: string;
  onFinalUrl?: (url: string) => void;
}

/**
 * Asks the browser-scraper service for the page.
 *
 * Returns `null` — and only `null` — when the remote scraper is **not
 * configured on this install**. The remote scraper is optional (see
 * `CLAUDE.md` and `docs/developer/SCRAPER_LIFECYCLE.md`), so a missing
 * `remote_scraper_url` is a configuration gap, not a scrape failure: the
 * caller degrades to plain HTTP rather than failing every scrape for the
 * domain forever. A remote scraper that *is* configured and then fails throws,
 * because silently serving HTTP to a retailer that was flagged as needing a
 * browser is how a BLOCKED page gets mistaken for a product page.
 */
export async function acquireRemoteHtml(options: RemoteAcquisitionOptions): Promise<string | null> {
  const { url, domain, domainConfig, productId, extractionSteps, requestId } = options;
  
  const rsUrl = await settingsCache.getRemoteScraperUrl();
  if (!rsUrl) {
    extractionSteps.push(`Scraper | Remote | URL not configured, falling back to HTTP`);
    logger.warn(`Scraper | Remote | Enabled for ${domain} but remote_scraper_url is not configured. Falling back to HTTP.`, 'Scraper');
    return null;
  }

  try {
    logger.info(`Scraper | Remote | Requesting ${domain} (Browser: true)`, 'Scraper');
    extractionSteps.push(`Scraper | Remote | Requesting via ${scrubUrlCredentials(rsUrl)}`);
    const remoteOptions = await buildRemoteOptions(options);
    
    // "Custom" now means the retailer's own override; the resolved system
    // default is no longer indistinguishable from sending nothing at all.
    logger.debug(`Scraper | Remote | Details | UA: ${remoteOptions.userAgent}, Proxy: ${remoteOptions.proxyUrl || 'None'}, Ref: ${remoteOptions.referrer || 'None'}`, 'Scraper');
    extractionSteps.push(`Scraper | Remote | UA: ${domainConfig?.user_agent ? 'Custom' : 'Default'} | Proxy: ${remoteOptions.proxyUrl ? 'Yes' : 'No'}`);
    
    const html = await fetchRemoteHtml(url, rsUrl, remoteOptions, options.onFinalUrl);
    extractionSteps.push(`Scraper | Remote | Success`);
    return html;
  } catch (e) {
    if (e instanceof PageNotAvailableError) throw e;
    const message = e instanceof Error ? e.message : String(e);
    extractionSteps.push(`Scraper | Remote | Failed: ${message}`);
    // This function only ever runs for a retailer whose config says
    // `use_browser_scraper`, so there is no HTTP path to fall back to: a
    // configured-but-failing browser scraper is a hard failure, never a quiet
    // downgrade. (`null` is reserved for "not configured at all", above.)
    logger.warn(`Scraper | Remote | Failed for ${domain} (Browser required): ${message}`, 'Scraper');
    throw e;
  }
}

async function buildRemoteOptions(options: RemoteAcquisitionOptions, amazonCartMode?: 'auto' | 'required'): Promise<RemoteScraperOptions> {
  const { domainConfig, productId, requestId } = options;
  const remoteOptions: RemoteScraperOptions = {
    productId,
    isDiscovery: !productId,
    requestId,
    userAgent: await resolveUserAgent(domainConfig?.user_agent),
    challengePatterns: await settingsCache.getGenericChallengePhrases(),
    delay: await settingsCache.getBrowserDelay(),
    timeout: await settingsCache.getBrowserTimeout(),
  };
  const proxy = domainConfig?.use_proxy ? await settingsCache.getScraperProxy() : undefined;
  if (proxy) {
    remoteOptions.useProxy = true;
    remoteOptions.proxyUrl = proxy;
  }
  if (amazonCartMode) {
    remoteOptions.amazonCartMode = amazonCartMode;
  } else {
    remoteOptions.referrer = domainConfig?.referrer || await settingsCache.getDefaultReferrer() || undefined;
  }
  return remoteOptions;
}

/** The dedicated endpoint cannot be mistaken for an older, unguarded scraper. */
export async function acquireRemoteAmazon(
  options: RemoteAcquisitionOptions,
  mode: 'auto' | 'required',
): Promise<RemoteScrapeResult | null> {
  if (options.domainConfig?.use_proxy && !options.domainConfig.use_browser_scraper) {
    options.extractionSteps.push('Amazon | Cart | Enable the browser scraper for this proxied retailer before checking the cart');
    logger.warn('Amazon cart verification requires the browser scraper to be enabled for a proxied retailer', 'Scraper', {
      requestId: options.requestId,
    });
    return null;
  }
  const rsUrl = await settingsCache.getRemoteScraperUrl();
  if (!rsUrl) return null;
  const remoteOptions = await buildRemoteOptions(options, mode);
  if (options.domainConfig?.use_proxy && !remoteOptions.proxyUrl) {
    options.extractionSteps.push('Amazon | Cart | Configured proxy is unavailable');
    logger.warn('Amazon cart verification requires the configured proxy', 'Scraper', { requestId: options.requestId });
    return null;
  }
  return fetchRemoteScrape(options.url, rsUrl, remoteOptions);
}
