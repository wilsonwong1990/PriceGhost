import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductConfirmationService } from '../../src/services/domain/product/add/confirmation';
import { scrapeProductWithVoting } from '../../src/services/scraper';
import { productPersistenceService } from '../../src/services/domain/product/ProductPersistenceService';
import { productRepository } from '../../src/models';

vi.mock('../../src/services/scraper', () => ({ scrapeProductWithVoting: vi.fn() }));
vi.mock('../../src/utils/system/url-safety', () => ({ assertUrlIsSafe: vi.fn() }));
vi.mock('../../src/services/domain/product/ProductPersistenceService', () => ({
  productPersistenceService: { saveScrapeResult: vi.fn() },
}));
vi.mock('../../src/models', () => ({
  productRepository: {
    create: vi.fn(),
    findById: vi.fn(),
    update: vi.fn(),
    bulkSetCheckingPaused: vi.fn(),
  },
}));

const url = 'https://www.amazon.com/dp/B012345678';
const candidate = { price: 78, currency: 'USD', method: 'custom-css', confidence: 0.9, selector: '#corePrice_feature_div .a-offscreen' };
const scraped = {
  url, name: 'Selected product', imageUrl: null, stockStatus: 'in_stock' as const,
  aiStatus: null, price: { price: 78, currency: 'USD' }, priceCandidates: [candidate], needsReview: false,
  html: '<div>selected</div>',
};
const selection = { selectedPrice: 78, selectedCurrency: 'USD', selectedMethod: 'custom-css', selector: '.other-product' };

describe('Amazon confirmation', () => {
  const service = new ProductConfirmationService();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(productRepository.findById).mockResolvedValue({ id: 1, url, checking_paused: false });
    vi.mocked(scrapeProductWithVoting).mockResolvedValue(scraped);
  });

  it('rejects a stale candidate and saves nothing', async () => {
    await expect(service.confirmProductSelection(1, 1, { ...selection, selectedPrice: 12 })).rejects.toThrow('could not confirm');
    expect(productPersistenceService.saveScrapeResult).not.toHaveBeenCalled();
    expect(productRepository.update).not.toHaveBeenCalled();
  });

  it('rejects a missing price instead of clearing review', async () => {
    await expect(service.confirmProductSelection(1, 1, {})).rejects.toThrow('valid price');
    expect(productPersistenceService.saveScrapeResult).not.toHaveBeenCalled();
  });

  it('revalidates the candidate and only saves the server-verified selector and stock', async () => {
    await service.confirmProductSelection(1, 1, { ...selection, stockStatus: 'out_of_stock', html: 'untrusted' });
    expect(productPersistenceService.saveScrapeResult).toHaveBeenCalledWith(
      1, 1, expect.objectContaining({ price: { price: 78, currency: 'USD' }, stockStatus: 'in_stock', html: scraped.html }),
      'manual-confirm', candidate.selector
    );
  });

  it('allows an explicit manual price without trusting page metadata or selectors', async () => {
    await service.confirmProductSelection(1, 1, {
      ...selection, selectedMethod: 'manual', name: 'Other product', stockStatus: 'in_stock', html: 'untrusted',
    });
    expect(scrapeProductWithVoting).not.toHaveBeenCalled();
    expect(productPersistenceService.saveScrapeResult).toHaveBeenCalledWith(
      1, 1, expect.objectContaining({ name: null, imageUrl: null, stockStatus: 'unknown', html: undefined }),
      'manual-confirm', undefined
    );
  });
});
