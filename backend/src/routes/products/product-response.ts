import { AMAZON_CART_METHOD } from '../../services/scraper/acquisition/amazon';
import type { StockStatus } from '../../models/types';

export function productResponse<T extends { stock_status: StockStatus; preferred_extraction_method?: string | null }>(product: T) {
  if (product.preferred_extraction_method !== AMAZON_CART_METHOD) return product;
  return {
    ...product,
    stock_status: 'unknown' as const,
    last_known_stock_status: product.stock_status,
    stock_status_verified: false,
  };
}
