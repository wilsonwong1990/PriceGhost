import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findDuplicateUrl: vi.fn(),
  create: vi.fn(),
  findById: vi.fn(),
  scrape: vi.fn(),
  save: vi.fn(),
  safe: vi.fn(),
}));

vi.mock('../../src/models', () => ({
  productRepository: {
    findDuplicateUrl: mocks.findDuplicateUrl,
    create: mocks.create,
    findById: mocks.findById,
  },
}));
vi.mock('../../src/services/scraper', () => ({ scrapeProductWithVoting: mocks.scrape }));
vi.mock('../../src/services/domain/product/ProductPersistenceService', () => ({
  productPersistenceService: { saveScrapeResult: mocks.save },
}));
vi.mock('../../src/services/domain/product/DefaultCheckIntervalService', () => ({
  defaultCheckIntervalService: { resolveForNewProduct: vi.fn().mockResolvedValue(43200) },
}));
vi.mock('../../src/utils/system/url-safety', () => ({ assertUrlIsSafe: mocks.safe }));

const url = 'https://www.amazon.com/dp/B012345678';
const observation = { asin: 'B012345678', marketplace: 'amazon.com', condition: 'new', price: 99, currency: 'USD' };
const verified = {
  url, name: null, imageUrl: null, stockStatus: 'unknown', aiStatus: null,
  price: { price: 99, currency: 'USD' }, priceCandidates: [], needsReview: false,
  amazonCartRequired: true, amazonCartObservation: observation,
};

describe('Amazon cart opt-in on product creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findDuplicateUrl.mockResolvedValue(null);
    mocks.create.mockResolvedValue({ id: 42 });
    mocks.findById.mockResolvedValue({ id: 42 });
    mocks.safe.mockResolvedValue(undefined);
    mocks.save.mockResolvedValue({});
    mocks.scrape.mockResolvedValue(verified);
  });

  it.each(['?seller=other', '?variant=red', '#offer', '/extra'])(
    'rejects a selected or ambiguous raw URL before cleaning: %s', async suffix => {
      const { productAddService } = await import('../../src/services/domain/product/add');
      await expect(productAddService.addProduct(1, `${url}${suffix}`, { amazonCart: true }))
        .rejects.toMatchObject({ statusCode: 400 });
      expect(mocks.findDuplicateUrl).not.toHaveBeenCalled();
      expect(mocks.scrape).not.toHaveBeenCalled();
    }
  );

  it('creates an opted-in product with its requirement in the initial row', async () => {
    const { productAddService } = await import('../../src/services/domain/product/add');
    await productAddService.addProduct(1, url, { amazonCart: true });
    expect(mocks.scrape).toHaveBeenCalledWith(
      url, 1, 'amazon-cart', undefined, undefined, undefined, undefined, undefined,
      { allowAmazonCart: true },
    );
    expect(mocks.create).toHaveBeenCalledWith(1, url, null, null, 43200, 'unknown', null, null, 'amazon-cart');
    expect(mocks.save).toHaveBeenCalledWith(42, 1, verified, 'manual-add');
  });

  it('does not create or start an unbound review when cart verification fails', async () => {
    mocks.scrape.mockResolvedValue({ ...verified, price: null, needsReview: true, amazonCartObservation: undefined });
    const { productAddService } = await import('../../src/services/domain/product/add');
    await expect(productAddService.addProduct(1, url, { amazonCart: true })).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('keeps ordinary Amazon discovery on the regular path without opt-in', async () => {
    mocks.scrape.mockResolvedValue({
      ...verified, amazonCartRequired: undefined, amazonCartObservation: undefined,
    });
    const { productAddService } = await import('../../src/services/domain/product/add');
    await productAddService.addProduct(1, url, {});
    expect(mocks.scrape).toHaveBeenCalledWith(
      url, 1, undefined, undefined, undefined, undefined, undefined, undefined,
      { allowAmazonCart: false },
    );
    expect(mocks.create.mock.calls[0][8]).toBeNull();
  });
});
