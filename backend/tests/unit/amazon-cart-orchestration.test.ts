import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as cheerio from 'cheerio';
import type { ScrapedProductWithVoting } from '../../src/types/scraper';

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  verify: vi.fn(),
}));

vi.mock('../../src/services/scraper/orchestration/init', () => ({
  initScrapeSession: async () => ({
    domain: 'amazon.com',
    lookupDomain: 'amazon.com',
    domainConfig: null,
    globalAiSettings: { ai_auto_mapping_enabled: false },
    finalSkipAiExtraction: true,
    finalSkipAiVerification: true,
    currencyHint: 'USD',
    localeHint: 'en_US',
  }),
}));

vi.mock('../../src/services/scraper/acquisition', () => ({ acquireHtml: mocks.acquire }));
vi.mock('../../src/services/scraper/orchestration/extraction', () => ({
  runExtractionPhase: async (_options: unknown, result: ScrapedProductWithVoting) => {
    result.price = { price: 208, currency: 'USD' };
    result.stockStatus = 'in_stock';
    result.priceCandidates = [{ price: 208, currency: 'USD', method: 'json-ld', confidence: 0.9 }];
    return { currencyHint: 'USD', localeHint: 'en_US' };
  },
}));
vi.mock('../../src/services/scraper/orchestration/consensus', () => ({
  runConsensusPhase: async () => {},
}));
vi.mock('../../src/services/scraper/orchestration/verification', () => ({
  runVerificationPhase: mocks.verify,
}));
vi.mock('../../src/services/scraper/orchestration/maintenance', () => ({
  handleRetailerMaintenance: async () => null,
  handleAutoMapping: async () => null,
  handleRestoreStatus: async () => {},
}));
vi.mock('../../src/utils/system/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const observation = {
  asin: 'B012345678',
  marketplace: 'amazon.com',
  condition: 'new',
  price: 249.99,
  currency: 'USD',
} as const;

function acquisition(cart: unknown, challengeReason: string | null = null) {
  return {
    html: '<div id="buybox">Add to Cart to see price</div>',
    $: cheerio.load('<div id="buybox">Add to Cart to see price</div>'),
    challengeReason,
    usedRemoteFallback: false,
    learnedFlags: {},
    amazonCart: cart,
  };
}

async function scrape(preferredMethod?: 'amazon-cart') {
  const { scrapeProductWithVoting } = await import('../../src/services/scraper/orchestration');
  return scrapeProductWithVoting('https://www.amazon.com/dp/B012345678', 1, preferredMethod);
}

describe('Amazon cart orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the verified cart price instead of a lower page offer', async () => {
    mocks.acquire.mockResolvedValue(acquisition({
      required: true, observation, metadata: { name: 'Fixture product', imageUrl: 'https://m.media-amazon.com/images/I/fixture.jpg' },
    }));
    const result = await scrape();
    expect(result.price).toEqual({ price: 249.99, currency: 'USD' });
    expect(result.selectedMethod).toBe('amazon-cart');
    expect(result.amazonCartObservation).toEqual(observation);
    expect(result.name).toBe('Fixture product');
    expect(result.imageUrl).toBe('https://m.media-amazon.com/images/I/fixture.jpg');
    expect(result.stockStatus).toBe('unknown');
    expect(result.priceCandidates).toEqual([expect.objectContaining({ price: 249.99, method: 'amazon-cart' })]);
    expect(result.needsReview).toBe(false);
    expect(result.html).toBeUndefined();
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it('does not expose a page offer or change stock when the cart is unverified', async () => {
    mocks.acquire.mockResolvedValue(acquisition({ required: true, observation: null }));
    const result = await scrape();
    expect(result.price).toBeNull();
    expect(result.priceCandidates).toEqual([]);
    expect(result.stockStatus).toBe('unknown');
    expect(result.needsReview).toBe(true);
    expect(result.unavailableReason).toBe('amazon_cart_price_unavailable');
    expect(result.html).toBeUndefined();
  });

  it('does not extract from an unavailable cart result', async () => {
    const extraction = await import('../../src/services/scraper/orchestration/extraction');
    const extract = vi.spyOn(extraction, 'runExtractionPhase');
    try {
      mocks.acquire.mockResolvedValue({
        ...acquisition({ required: true, observation: null }),
        html: '', $: cheerio.load(''), cartStatusOnly: true,
      });
      const result = await scrape('amazon-cart');
      expect(extract).not.toHaveBeenCalled();
      expect(mocks.verify).not.toHaveBeenCalled();
      expect(result.unavailableReason).toBe('amazon_cart_price_unavailable');
      expect(result.price).toBeNull();
    } finally {
      extract.mockRestore();
    }
  });

  it('does not accept an observation when the product page is challenged', async () => {
    mocks.acquire.mockResolvedValue(acquisition({ required: true, observation }, 'Bot challenge'));
    const result = await scrape();
    expect(result.price).toBeNull();
    expect(result.stockStatus).toBe('unknown');
    expect(result.unavailableReason).toBe('amazon_cart_price_unavailable');
  });

  it('retains the cart requirement when acquisition fails', async () => {
    mocks.acquire.mockRejectedValue(new Error('Browser Scraper failed'));
    const result = await scrape('amazon-cart');
    expect(result.amazonCartRequired).toBe(true);
    expect(result.price).toBeNull();
    expect(result.unavailableReason).toBe('remote_scraper_failure');
  });

  it('retains the cart requirement for a previously flagged short link', async () => {
    mocks.acquire.mockResolvedValue(acquisition({ required: false, observation: null }));
    const { scrapeProductWithVoting } = await import('../../src/services/scraper/orchestration');
    const result = await scrapeProductWithVoting('https://a.co/short', 1, 'amazon-cart');
    expect(mocks.acquire).toHaveBeenCalledWith(expect.objectContaining({ requireAmazonCart: true }));
    expect(result.price).toBeNull();
    expect(result.unavailableReason).toBe('amazon_cart_price_unavailable');
  });

  it('preserves ordinary extraction when the page does not require a cart price', async () => {
    mocks.acquire.mockResolvedValue(acquisition({ required: false, observation: null }));
    const result = await scrape();
    expect(result.price).toEqual({ price: 208, currency: 'USD' });
    expect(result.html).toContain('Add to Cart');
    expect(mocks.verify).toHaveBeenCalledTimes(1);
  });

});
