import { describe, expect, it, vi } from 'vitest';
import { load } from 'cheerio';
import { scopeAmazonPage } from '../../src/services/scraper/extractors/amazon-scope';
import { runExtractionPhase } from '../../src/services/scraper/orchestration/extraction';
import { runConsensusPhase } from '../../src/services/scraper/orchestration/consensus';
import type { ScrapedProductWithVoting } from '../../src/types/scraper';
import type { RetailerConfig } from '../../src/models';

vi.mock('../../src/services/scraper/context', () => ({
  resolveScrapeContext: async () => ({ currency: 'USD', locale: 'en-US' }),
}));
vi.mock('../../src/utils/i18n/currency/cache', () => ({
  currencyCache: { getGlobalCurrenciesSync: () => [{ locale: 'en_US', iso: 'USD', symbol: '$' }] },
}));
vi.mock('../../src/utils/cache', () => ({
  settingsCache: {
    getPriceSelectors: async () => [],
    getGenericStockSelectors: async () => [],
    getNameSelectors: async () => [],
    getImageSelectors: async () => [],
    getGenericExclusionSelectors: async () => [],
    getGenericPreOrderPhrases: async () => [],
    getGenericOutOfStockPhrases: async () => ['out of stock'],
    getGenericInStockPhrases: async () => ['in stock'],
  },
}));
vi.mock('../../src/services/scraper/extractors/dom-denoiser', () => ({ denoiseDomForExtraction: () => {} }));
vi.mock('../../src/services/scraper/metadata', () => ({
  extractMetadata: async (_$: unknown, _config: unknown, _steps: unknown, result: ScrapedProductWithVoting) => {
    result.stockStatus = 'in_stock';
  },
}));
vi.mock('../../src/services/scraper/prices', () => ({
  extractAllPriceCandidates: async () => [
    { price: 12, currency: 'USD', method: 'deal-price', confidence: 0.99 },
    { price: 78, currency: 'USD', method: 'generic-css', confidence: 0.6 },
  ],
}));

describe('Amazon extraction and preference', () => {
  it('filters both extraction passes and resolves stock from the selected offer only', async () => {
    const url = 'https://www.amazon.com/dp/B012345678';
    const scoped = scopeAmazonPage(url, load(`
      <html><body><input id="ASIN" value="B012345678">
        <div id="corePrice_feature_div" data-csa-c-asin="B012345678">
          <span class="apex-pricetopay-value"><span class="a-offscreen">$78.00</span></span>
        </div>
        <div id="availabilityInsideBuyBox_feature_div" data-csa-c-asin="B012345678">
          <div id="availability">Out of stock</div>
        </div>
        <div>In stock <span>$12.00</span></div>
      </body></html>
    `));
    expect(scoped.kind).toBe('scoped');
    if (scoped.kind !== 'scoped') return;
    const result: ScrapedProductWithVoting = {
      url, name: null, imageUrl: null, price: null, stockStatus: 'unknown',
      aiStatus: null, needsReview: false,
      priceCandidates: [{ price: 12, currency: 'USD', method: 'deal-price', confidence: 0.99 }],
    };
    const options = {
      url, html: scoped.html, $: load(scoped.html),
      domainConfig: { pre_order_price_selectors: ['#availability'] } as RetailerConfig,
      currencyHint: 'USD', localeHint: 'en-US', extractionSteps: [], amazonStockHtml: scoped.stockHtml,
    };
    await runExtractionPhase(options, result);
    await runExtractionPhase({ ...options, $: load(scoped.html) }, result);
    expect(result.stockStatus).toBe('out_of_stock');
    expect(result.priceCandidates.length).toBeGreaterThan(0);
    expect(result.priceCandidates.every(c => c.price === 78 && c.currency === 'USD')).toBe(true);

    await runConsensusPhase({
      url, html: scoped.html, finalSkipAiExtraction: true, preferredMethod: 'deal-price', extractionSteps: [],
    }, result);
    expect(result.price?.price).not.toBe(12);
  });

  it('does not invent availability when the scoped offer has none', async () => {
    const url = 'https://www.amazon.com/dp/B012345678';
    const result: ScrapedProductWithVoting = {
      url, name: null, imageUrl: null, price: null, stockStatus: 'unknown',
      aiStatus: null, needsReview: false, priceCandidates: [],
    };
    const html = '<div id="corePrice_feature_div"><span class="apex-pricetopay-value"><span class="a-offscreen">$78.00</span></span></div>';
    await runExtractionPhase({
      url, html, $: load(html), domainConfig: { pre_order_price_selectors: ['#availability'] } as RetailerConfig,
      currencyHint: 'USD', localeHint: 'en-US', extractionSteps: [], amazonStockHtml: '',
    }, result);
    expect(result.stockStatus).toBe('unknown');
    expect(result.stockCandidates).toEqual([]);
  });
});
