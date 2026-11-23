import { beforeEach, describe, expect, it, vi } from 'vitest';
import { load } from 'cheerio';
import type { ScrapedProductWithVoting } from '../../src/types/scraper';

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  extract: vi.fn(),
  consensus: vi.fn(),
  verify: vi.fn(),
  restore: vi.fn(),
  autoMap: vi.fn(),
}));

vi.mock('../../src/services/scraper/orchestration/init', () => ({
  initScrapeSession: async () => ({
    domain: 'amazon.com', lookupDomain: 'amazon.com', domainConfig: null,
    globalAiSettings: { ai_auto_mapping_enabled: true },
    finalSkipAiExtraction: false, finalSkipAiVerification: false, currencyHint: 'USD', localeHint: 'en-US',
  }),
}));
vi.mock('../../src/services/scraper/acquisition', () => ({ acquireHtml: mocks.acquire }));
vi.mock('../../src/services/scraper/orchestration/extraction', () => ({ runExtractionPhase: mocks.extract }));
vi.mock('../../src/services/scraper/orchestration/consensus', () => ({ runConsensusPhase: mocks.consensus }));
vi.mock('../../src/services/scraper/orchestration/verification', () => ({ runVerificationPhase: mocks.verify }));
vi.mock('../../src/services/scraper/orchestration/maintenance', () => ({
  handleRetailerMaintenance: async () => null, handleAutoMapping: mocks.autoMap, handleRestoreStatus: mocks.restore,
}));
vi.mock('../../src/utils/system/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { scrapeProductWithVoting } from '../../src/services/scraper/orchestration';

const url = 'https://www.amazon.com/dp/B012345678';
const html = `<html><body><input id="ASIN" value="B012345678">
  <div id="corePrice_feature_div" data-csa-c-asin="B012345678">
    <span class="apex-pricetopay-value"><span class="a-offscreen">$78.00</span></span>
  </div><div class="recommendation">$12.00</div></body></html>`;

describe('Amazon orchestration safety', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.acquire.mockResolvedValue({ html, $: load(html), challengeReason: null });
    mocks.extract.mockImplementation(async (options, result: ScrapedProductWithVoting) => {
      if (options.html) result.priceCandidates = [{ price: 78, currency: 'USD', method: 'custom-css', confidence: 0.9 }];
      return { currencyHint: 'USD', localeHint: 'en-US' };
    });
    mocks.autoMap.mockResolvedValue({ price_selectors: ['.apex-pricetopay-value'] });
  });

  it('passes scoped HTML to auto-mapping and both extraction passes, then rejects an AI correction to another price', async () => {
    mocks.consensus.mockImplementation(async (_options, result: ScrapedProductWithVoting) => {
      result.price = { price: 78, currency: 'USD' };
    });
    mocks.verify.mockImplementation(async (_options, result: ScrapedProductWithVoting) => {
      result.price = { price: 12, currency: 'USD' };
    });
    const result = await scrapeProductWithVoting(url, 1, 'custom-css');
    expect(mocks.extract).toHaveBeenCalledTimes(2);
    for (const [options] of mocks.extract.mock.calls) {
      expect(options.html).toContain('$78.00');
      expect(options.html).not.toContain('$12.00');
      expect(options.amazonStockHtml).toBeDefined();
    }
    expect(mocks.autoMap.mock.calls[0][0].html).not.toContain('$12.00');
    expect(result.price).toBeNull();
    expect(result.needsReview).toBe(true);
    expect(mocks.restore.mock.calls[0][0].price).toBeNull();
  });

  it('does not use prices on an Amazon challenge page as success-first evidence', async () => {
    mocks.acquire.mockResolvedValue({ html, $: load(html), challengeReason: 'challenge' });
    const result = await scrapeProductWithVoting(url, 1);
    expect(mocks.extract.mock.calls[0][0].html).toBe('');
    expect(result.failureReason).toBe('bot_challenge');
    expect(result.priceCandidates).toEqual([]);
    expect(mocks.autoMap).not.toHaveBeenCalled();
  });

  it('does not extract an Amazon page when the requested ASIN is not selected', async () => {
    mocks.acquire.mockResolvedValue({ html, $: load(html.replace('value="B012345678"', 'value="B098765432"')), challengeReason: null });
    const result = await scrapeProductWithVoting(url, 1);
    expect(result.failureReason).toBe('variant_selection_required');
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.restore).not.toHaveBeenCalled();
  });
});
