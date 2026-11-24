import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  browser: vi.fn(),
  cart: vi.fn(),
  standard: vi.fn(),
}));
vi.mock('../../src/services/scraper/acquisition/remote', () => ({
  acquireRemoteHtml: mocks.browser,
  acquireRemoteAmazon: mocks.cart,
}));
vi.mock('../../src/services/scraper/acquisition/standard', () => ({
  acquireStandardHtml: mocks.standard,
  BotChallengeError: class BotChallengeError extends Error {},
}));

const url = 'https://www.amazon.com/dp/B012345678';
const options = { url, domain: 'amazon.com', extractionSteps: [] as string[] };

describe('Amazon cart acquisition opt-in', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.browser.mockResolvedValue('<html>Browser product</html>');
    mocks.standard.mockResolvedValue('<html>Product</html>');
  });

  it('retains the configured browser path without initiating a cart', async () => {
    const { acquireHtml } = await import('../../src/services/scraper/acquisition');
    const result = await acquireHtml({ ...options, domainConfig: { use_browser_scraper: true } as never });
    expect(result.html).toContain('Browser product');
    expect(mocks.browser).toHaveBeenCalledOnce();
    expect(mocks.cart).not.toHaveBeenCalled();
    expect(mocks.standard).not.toHaveBeenCalled();
  });

  it('uses only the dedicated endpoint for an opted-in product', async () => {
    mocks.cart.mockResolvedValue({
      challengeDetected: false,
      amazonCart: {
        required: true, status: 'verified', asin: 'B012345678', marketplace: 'amazon.com', condition: 'new',
        price: 99, currency: 'USD',
        metadata: { name: 'Fixture product', imageUrl: 'https://m.media-amazon.com/images/I/fixture.jpg' },
      },
    });
    const { acquireHtml } = await import('../../src/services/scraper/acquisition');
    const result = await acquireHtml({ ...options, requireAmazonCart: true, allowAmazonCart: true });
    expect(result.amazonCart?.observation?.price).toBe(99);
    expect(result.amazonCart?.metadata).toEqual({
      name: 'Fixture product', imageUrl: 'https://m.media-amazon.com/images/I/fixture.jpg',
    });
    expect(result.html).toBe('');
    expect(mocks.cart).toHaveBeenCalledOnce();
    expect(mocks.browser).not.toHaveBeenCalled();
    expect(mocks.standard).not.toHaveBeenCalled();
  });

  it('fails closed without falling back when no cart capability is available', async () => {
    mocks.cart.mockResolvedValue(null);
    const { acquireHtml } = await import('../../src/services/scraper/acquisition');
    const result = await acquireHtml({ ...options, requireAmazonCart: true, allowAmazonCart: true });
    expect(result.amazonCart?.observation).toBeNull();
    expect(result.cartStatusOnly).toBe(true);
    expect(mocks.browser).not.toHaveBeenCalled();
    expect(mocks.standard).not.toHaveBeenCalled();
  });

  it('rejects challenged or missing challenge evidence', async () => {
    mocks.cart.mockResolvedValue({
      amazonCart: { required: true, status: 'verified', asin: 'B012345678', marketplace: 'amazon.com', condition: 'new', price: 99, currency: 'USD' },
    });
    const { acquireHtml } = await import('../../src/services/scraper/acquisition');
    const result = await acquireHtml({ ...options, requireAmazonCart: true, allowAmazonCart: true });
    expect(result.amazonCart?.observation).toBeNull();
  });
});
