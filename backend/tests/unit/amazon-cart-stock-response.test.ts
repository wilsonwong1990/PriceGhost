// Verify stale stock is not presented as current for cart-price listings.
import { describe, expect, it, vi } from 'vitest';
import { productResponse } from '../../src/routes/products/product-response';

const repositories = vi.hoisted(() => ({
  product: { findById: vi.fn() },
  stock: { getByProductId: vi.fn(), getStats: vi.fn() },
}));

vi.mock('../../src/models', () => ({
  productRepository: repositories.product,
  stockHistoryRepository: repositories.stock,
  priceHistoryRepository: {},
  userRepository: {},
}));

describe('cart listing stock responses', () => {
  it('marks prior stock as last-known, not current', () => {
    expect(productResponse({ stock_status: 'in_stock', preferred_extraction_method: 'amazon-cart' }))
      .toEqual({
        stock_status: 'unknown', preferred_extraction_method: 'amazon-cart',
        last_known_stock_status: 'in_stock', stock_status_verified: false,
      });
    expect(productResponse({ stock_status: 'in_stock', preferred_extraction_method: null }))
      .toEqual({ stock_status: 'in_stock', preferred_extraction_method: null });
  });

  it('returns real historical events without inventing current availability statistics', async () => {
    repositories.product.findById.mockResolvedValue({
      stock_status: 'in_stock', preferred_extraction_method: 'amazon-cart',
    });
    repositories.stock.getByProductId.mockResolvedValue([
      { status: 'out_of_stock', changed_at: '2024-12-01T00:00:00.000Z', recorded_at: '2024-01-01T00:00:00.000Z' },
      { status: 'in_stock', changed_at: '2025-01-01T00:00:00.000Z' },
    ]);
    const { ProductHistoryService } = await import('../../src/services/domain/product/ProductHistoryService');
    expect(await new ProductHistoryService().getStockHistory(1, 1)).toEqual({
      history: [{ status: 'in_stock', changed_at: '2025-01-01T00:00:00.000Z' }],
      stats: null,
      stock_status_verified: false,
    });
    expect(repositories.stock.getStats).not.toHaveBeenCalled();
  });
});
