import { load, type CheerioAPI } from 'cheerio';
import { detectBotChallenge, PageNotAvailableError, RemoteCartCapabilityUnavailable } from '../transport';
import { RetailerConfig } from '../../../models';
import type { AcquisitionMetadata } from '../../../types/scraper';
import type { RetailerBrowserEngine } from '../../../models/types/retailer';

import { acquireRemoteAmazon, acquireRemoteHtml } from './remote';
import { acquireStandardHtml, BotChallengeError } from './standard';
import { handleAcquisitionFallback } from './fallback';
import { amazonTarget, readAmazonCartMetadata, readAmazonCartObservation, type AmazonCartObservation } from './amazon';

export interface AcquisitionOptions {
  url: string;
  domain: string;
  domainConfig?: RetailerConfig;
  productId?: number;
  extractionSteps: string[];
  requestId?: string;
  requireAmazonCart?: boolean;
  allowAmazonCart?: boolean;
}

export interface AcquisitionResult {
  html: string;
  $: CheerioAPI;
  challengeReason: string | null;
  usedRemoteFallback: boolean;
  learnedFlags: any;
  amazonCart?: { required: boolean; observation: AmazonCartObservation | null; metadata?: { name: string | null; imageUrl: string | null } };
  cartStatusOnly?: boolean;
  acquisition?: AcquisitionMetadata;
}

export async function acquireHtml(options: AcquisitionOptions): Promise<AcquisitionResult> {
  const { url, domain, domainConfig, productId, extractionSteps, requestId } = options;
  const target = options.requireAmazonCart ? amazonTarget(url) : null;
  if (options.requireAmazonCart && (!target || !options.allowAmazonCart)) {
    extractionSteps.push(target
      ? 'Amazon | Cart | Verification is limited to product tracking'
      : 'Amazon | Cart | A canonical HTTPS product URL is required');
    return {
      html: '', $: load(''), challengeReason: null, usedRemoteFallback: false, learnedFlags: {},
      amazonCart: { required: true, observation: null },
    };
  }
  if (target && options.requireAmazonCart) {
    let remote;
    try {
      remote = await acquireRemoteAmazon({ ...options, url: target.productUrl }, 'required');
    } catch (error) {
      if (error instanceof RemoteCartCapabilityUnavailable) {
        extractionSteps.push('Amazon | Cart | Browser scraper needs an update');
      } else {
        throw error;
      }
      remote = null;
    }
    // Guest-cart HTML may contain ephemeral session and offer fields.
    const observation = remote?.challengeDetected === false
      ? readAmazonCartObservation(remote.amazonCart, target)
      : null;
    return {
      html: '', $: load(''), challengeReason: null, usedRemoteFallback: false, learnedFlags: {},
      amazonCart: { required: true, observation, metadata: observation ? readAmazonCartMetadata(remote?.amazonCart) : undefined },
      cartStatusOnly: !observation,
      acquisition: remote ? { mode: 'browser', browserEngine: remote.browserEngine } : undefined,
    };
  }
  let html = '';
  let learnedFlags: any = {};
  let challengeReason: string | null = null;
  let usedRemoteFallback = false;
  let browserEngine: RetailerBrowserEngine | undefined;
  let acquisition: AcquisitionMetadata | undefined;
  const onEngine = (engine: RetailerBrowserEngine | undefined) => { browserEngine = engine; };

  const useBrowserScraper = domainConfig?.use_browser_scraper || false;

  // Set when the retailer asks for the browser scraper but this install has no
  // `remote_scraper_url`. The remote scraper is optional, so that is a
  // configuration gap rather than a scrape failure: HTTP is still tried, which
  // is what stops a once-flagged domain from being pinned to a path that
  // cannot run. See `acquireRemoteHtml`.
  let remoteScraperUnavailable = false;

  // --- Attempt 1: Remote/Browser (if configured) ---
  if (useBrowserScraper) {
    usedRemoteFallback = true;
    learnedFlags = { use_browser_scraper: true };
    const remoteHtml = await acquireRemoteHtml({ ...options, onEngine });
    if (remoteHtml === null) {
      remoteScraperUnavailable = true;
      usedRemoteFallback = false;
    } else if (remoteHtml) {
      html = remoteHtml;
      acquisition = { mode: 'browser', browserEngine };
    }
  }

  // --- Attempt 2: Standard HTTP (if not configured for the browser, or the
  // browser scraper this install was told to use does not exist) ---
  if (!html && (!useBrowserScraper || remoteScraperUnavailable)) {
    try {
      html = await acquireStandardHtml({
        url,
        domain,
        domainConfig,
        extractionSteps,
        requestId,
      });
      if (html) acquisition = { mode: 'http' };
    } catch (e) {
      if (e instanceof BotChallengeError) {
        challengeReason = e.message;
      } else {
        throw e;
      }
    }
  }

  let $ = load(html || '');
  
  if (html) {
     const htmlChallenge = detectBotChallenge(html, $);
     if (htmlChallenge) {
       challengeReason = htmlChallenge;
     } else {
       checkSoft404($, html, extractionSteps);
     }
  }

  // --- Attempt 3: Dynamic Fallback (if blocked and no config exists) ---
  if (challengeReason && !usedRemoteFallback && !domainConfig) {
    const fallbackResult = await handleAcquisitionFallback({
      url,
      domain,
      productId,
      extractionSteps,
      challengeReason,
      onEngine
      // No retailer override to pass: this branch only runs when the domain has
      // no config, so the system default is the right identity -- and is the
      // one the HTTP attempt just used.
    });

    if (fallbackResult) {
      return {
        ...fallbackResult,
        usedRemoteFallback: true,
        acquisition: { mode: 'browser', browserEngine }
      };
    }
    // Deliberately no `learnedFlags = { use_browser_scraper: true }` here.
    // Reaching this line means the browser fallback produced nothing -- most
    // often because the remote scraper is not configured at all, in which case
    // `fetchBrowserHtml` returns '' without ever opening a browser. A fallback
    // that failed is not evidence that the browser is what this domain needs,
    // and persisting the flag on that non-evidence pinned the domain to a path
    // it could not take: HTTP was then skipped, Attempt 3 was gated off by the
    // now-existing config, and nothing cleared the flag. A transient 403 has to
    // stay self-healing on the next scrape.
  }

  return { html, $, challengeReason, usedRemoteFallback, learnedFlags, acquisition };
}

function checkSoft404($: CheerioAPI, html: string, extractionSteps: string[]) {
  // 1. Check title for "not found" / "404" markers
  const title = $('title').text().trim().toLowerCase();
  const notFoundPatterns = [
    'product not found',
    'page not found',
    '404 not found',
    '404 error',
    'item not found',
    'not found'
  ];
  
  if (title) {
    for (const pattern of notFoundPatterns) {
      if (title === pattern || (pattern !== 'not found' && title.includes(pattern))) {
        extractionSteps.push(`Soft-404 | Title match: "${title}" contains "${pattern}"`);
        throw new PageNotAvailableError(`Soft 404: Title matches "${pattern}"`, 'soft_404_title');
      }
    }
  }

  // 2. Check meta robots noindex (as a strong signal of soft 404 / deactivated page)
  const robots = $('meta[name="robots"]').attr('content')?.toLowerCase() || '';
  if (robots.includes('noindex') || robots === 'none') {
    const hasPriceMeta = $('meta[itemprop="price"], meta[itemprop="lowPrice"], [itemprop="price"], [itemprop="lowPrice"], meta[property="product:price:amount"], meta[property="og:price:amount"]').length > 0;
    
    let hasJsonLdProduct = false;
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const text = $(el).html();
        if (text && (text.includes('"Product"') || text.includes('"Offer"') || text.includes('"price"'))) {
          hasJsonLdProduct = true;
        }
      } catch (e) {}
    });

    if (!hasPriceMeta && !hasJsonLdProduct) {
      extractionSteps.push(`Soft-404 | Robots meta tag contains noindex: "${robots}"`);
      throw new PageNotAvailableError(`Soft 404: Robots meta tag contains noindex (${robots})`, 'soft_404_noindex');
    } else {
      extractionSteps.push(`Soft-404 | Robots meta has noindex but page has valid product/price metadata. Skipping robots check.`);
    }
  }

  // 3. Check for specific page content or elements commonly indicating not found
  const soft404Selectors = [
    '.error-404',
    '.product-not-found',
    '.no-results',
    '#not-found',
    '.page-not-found'
  ];
  for (const selector of soft404Selectors) {
    if ($(selector).length > 0) {
      extractionSteps.push(`Soft-404 | Found error selector: "${selector}"`);
      throw new PageNotAvailableError(`Soft 404: Found error element "${selector}"`, 'soft_404_element');
    }
  }
}
