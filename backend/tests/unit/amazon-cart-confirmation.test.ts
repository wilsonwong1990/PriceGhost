import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  findById: vi.fn(),
  update: vi.fn(),
  saveScrapeResult: vi.fn(),
  rememberAmazonCartRequirement: vi.fn(),
  scrape: vi.fn(),
  assertUrlIsSafe: vi.fn(),
}));

vi.mock('../../src/models', () => ({
  productRepository: {
    create: mocks.create,
    findById: mocks.findById,
    update: mocks.update,
    bulkSetCheckingPaused: vi.fn(),
  },
}));
vi.mock('../../src/services/domain/product/ProductPersistenceService', () => ({
  productPersistenceService: {
    saveScrapeResult: mocks.saveScrapeResult,
    rememberAmazonCartRequirement: mocks.rememberAmazonCartRequirement,
  },
}));
vi.mock('../../src/services/scraper', () => ({ scrapeProductWithVoting: mocks.scrape }));
vi.mock('../../src/utils/system/url-safety', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/utils/system/url-safety')>(),
  assertUrlIsSafe: mocks.assertUrlIsSafe,
}));
vi.mock('../../src/utils/system/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const forgedObservation = {
  asin: 'B012345678', marketplace: 'amazon.com', condition: 'new', price: 99, currency: 'USD',
};
const verifiedScrape = {
  url: 'https://www.amazon.com/dp/B012345678',
  name: null,
  imageUrl: null,
  stockStatus: 'in_stock',
  aiStatus: null,
  price: { price: 249.99, currency: 'USD' },
  priceCandidates: [],
  needsReview: false,
  amazonCartRequired: true,
  amazonCartObservation: {
    asin: 'B012345678', marketplace: 'amazon.com', condition: 'new', price: 249.99, currency: 'USD',
  },
};

describe('Amazon cart confirmation boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockResolvedValue({ id: 42 });
    mocks.findById.mockResolvedValue({
      id: 42, url: 'https://www.amazon.com/dp/B012345678', preferred_extraction_method: 'amazon-cart',
    });
    mocks.update.mockResolvedValue(undefined);
    mocks.saveScrapeResult.mockResolvedValue(null);
    mocks.rememberAmazonCartRequirement.mockResolvedValue(undefined);
    mocks.scrape.mockResolvedValue({ ...verifiedScrape, amazonCartObservation: undefined, price: null });
    mocks.assertUrlIsSafe.mockResolvedValue(undefined);
  });

  it('does not trust cart evidence supplied when creating a product', async () => {
    const { productConfirmationService } = await import('../../src/services/domain/product/add/confirmation');
    await expect(productConfirmationService.confirmNewProduct(1, 'https://www.amazon.com/dp/B012345678', {
      selectedPrice: 99,
      selectedCurrency: 'USD',
      selectedMethod: 'amazon-cart',
      amazonCartObservation: forgedObservation,
    })).rejects.toMatchObject({ statusCode: 409 });

    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.saveScrapeResult).not.toHaveBeenCalled();
  });

  it('creates a product only after independently re-verifying the chosen cart price', async () => {
    const scraped = { ...verifiedScrape, name: 'Verified product', imageUrl: 'https://m.media-amazon.com/images/I/product.jpg' };
    mocks.scrape.mockResolvedValue(scraped);
    const { productConfirmationService } = await import('../../src/services/domain/product/add/confirmation');
    await productConfirmationService.confirmNewProduct(1, 'https://www.amazon.com/dp/B012345678', {
      selectedPrice: 249.99,
      selectedCurrency: 'USD',
      selectedMethod: 'amazon-cart',
      name: 'Untrusted name',
      imageUrl: 'https://untrusted.example/image.jpg',
      amazonCartObservation: forgedObservation,
    });

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith(
      1, 'https://www.amazon.com/dp/B012345678', 'Verified product',
      'https://m.media-amazon.com/images/I/product.jpg', expect.any(Number), 'in_stock', null, null, 'amazon-cart'
    );
    expect(mocks.saveScrapeResult).toHaveBeenCalledWith(42, 1, scraped, 'manual-add', undefined);
  });

  it('rejects a page price for an existing cart-tracked product', async () => {
    const { productConfirmationService } = await import('../../src/services/domain/product/add/confirmation');
    await expect(productConfirmationService.confirmProductSelection(1, 42, {
      selectedPrice: 99,
      selectedCurrency: 'USD',
      selectedMethod: 'json-ld',
      amazonCartRequired: false,
      amazonCartObservation: forgedObservation,
    })).rejects.toMatchObject({ statusCode: 409 });

    expect(mocks.scrape).not.toHaveBeenCalled();
    expect(mocks.saveScrapeResult).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('persists a fresh server-verified cart result when a re-scan is confirmed', async () => {
    mocks.scrape.mockResolvedValue(verifiedScrape);
    const { productConfirmationService } = await import('../../src/services/domain/product/add/confirmation');
    await productConfirmationService.confirmProductSelection(1, 42, {
      selectedPrice: 249.99,
      selectedCurrency: 'USD',
      selectedMethod: 'amazon-cart',
      amazonCartObservation: forgedObservation,
    });

    expect(mocks.scrape).toHaveBeenCalledWith(
      'https://www.amazon.com/dp/B012345678', 1, 'amazon-cart',
      undefined, undefined, undefined, undefined, 42, { allowAmazonCart: true }
    );
    expect(mocks.saveScrapeResult).toHaveBeenCalledWith(42, 1, verifiedScrape, 'refresh', undefined);
  });

  it('marks an existing cart listing unavailable when confirmation cannot reverify it', async () => {
    const { productConfirmationService } = await import('../../src/services/domain/product/add/confirmation');
    await expect(productConfirmationService.confirmProductSelection(1, 42, {
      selectedPrice: 249.99, selectedCurrency: 'USD', selectedMethod: 'amazon-cart',
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.rememberAmazonCartRequirement).toHaveBeenCalledWith(42, 1, 'amazon_cart_price_unavailable', undefined);
    expect(mocks.saveScrapeResult).not.toHaveBeenCalled();
  });

  it('rejects a confirmed selection if the newly verified cart price changed', async () => {
    mocks.scrape.mockResolvedValue(verifiedScrape);
    const { productConfirmationService } = await import('../../src/services/domain/product/add/confirmation');
    await expect(productConfirmationService.confirmProductSelection(1, 42, {
      selectedPrice: 99, selectedCurrency: 'USD', selectedMethod: 'amazon-cart',
    })).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('price changed') });
    expect(mocks.rememberAmazonCartRequirement).toHaveBeenCalledWith(42, 1, 'amazon_cart_price_unavailable', undefined);
    expect(mocks.saveScrapeResult).not.toHaveBeenCalled();
  });

  it('rejects a stale manual choice if the cart requirement appeared concurrently', async () => {
    mocks.findById.mockResolvedValueOnce({
      id: 42, url: 'https://www.amazon.com/dp/B012345678', preferred_extraction_method: null,
    });
    mocks.saveScrapeResult.mockResolvedValue({ stock: null, price: null, ignored: true });
    mocks.scrape.mockResolvedValue({ amazonPageDetected: true, amazonCartRequired: false, terminalDestinationVerified: true });
    const { productConfirmationService } = await import('../../src/services/domain/product/add/confirmation');
    await expect(productConfirmationService.confirmProductSelection(1, 42, {
      selectedPrice: 99, selectedCurrency: 'USD', selectedMethod: 'json-ld',
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('allows ordinary manual confirmation without a new inspection', async () => {
    const { productConfirmationService } = await import('../../src/services/domain/product/add/confirmation');
    await productConfirmationService.confirmNewProduct(1, 'https://retailer.example/item', {
      selectedPrice: 99, selectedCurrency: 'USD', selectedMethod: 'manual',
    });
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.saveScrapeResult).toHaveBeenCalledOnce();
    expect(mocks.scrape).not.toHaveBeenCalled();
  });

  it('persists explicit opt-in before beginning the rescan', async () => {
    mocks.findById.mockResolvedValueOnce({
      id: 42, url: 'https://www.amazon.com/dp/B012345678', preferred_extraction_method: null,
    });

    const { productRescanService } = await import('../../src/services/domain/product/add/rescan');
    const result = await productRescanService.scanProduct(1, 42, true);
    expect(result.amazonCartRequired).toBe(true);
    expect(mocks.rememberAmazonCartRequirement).toHaveBeenCalledWith(42, 1);
    expect(mocks.rememberAmazonCartRequirement.mock.invocationCallOrder[0]).toBeLessThan(mocks.scrape.mock.invocationCallOrder[0]);
    expect(mocks.rememberAmazonCartRequirement).toHaveBeenCalledWith(42, 1, 'amazon_cart_price_unavailable', undefined);
  });

  it('uses the original observation timestamp to guard a failed rescan', async () => {
    const lastChecked = new Date('2026-01-01T00:00:00Z');
    mocks.findById.mockResolvedValueOnce({
      id: 42, url: 'https://www.amazon.com/dp/B012345678',
      preferred_extraction_method: 'amazon-cart', last_checked: lastChecked,
    });
    const { productRescanService } = await import('../../src/services/domain/product/add/rescan');
    await productRescanService.scanProduct(1, 42);
    expect(mocks.rememberAmazonCartRequirement).toHaveBeenCalledWith(
      42, 1, 'amazon_cart_price_unavailable', lastChecked
    );
  });

  it('does not allow cart pricing on a non-Amazon URL', async () => {
    const { productConfirmationService } = await import('../../src/services/domain/product/add/confirmation');
    await expect(productConfirmationService.confirmNewProduct(1, 'https://example.test/item', {
      selectedPrice: 99, selectedCurrency: 'USD', selectedMethod: 'amazon-cart',
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
