import type { Product, ProductWithStats } from '../types/api';
import { queryClient } from './queryClient';
import { queryKeys } from './queries';

/** Applies a canonical product mutation response without discarding detail-only stats. */
export function syncProductCaches(updated: Product): void {
  queryClient.setQueryData<Product[]>(queryKeys.products.all, (products) =>
    products?.map((product) => product.id === updated.id ? { ...product, ...updated } : product),
  );
  queryClient.setQueryData<ProductWithStats>(queryKeys.products.detail(updated.id), (product) =>
    product ? { ...product, ...updated } : product,
  );
}

/**
 * Hides a cached cart price once a refresh could not verify it, so a failed
 * reload cannot leave the previous verified price on screen.
 */
export function clearUnverifiedCartPrice(productId: number): void {
  const clear = <T extends Product>(product: T): T => ({
    ...product,
    current_price: null,
    currency: null,
    converted_price: null,
    stock_status: 'unknown',
    preferred_extraction_method: 'amazon-cart',
    unavailable_reason: 'amazon_cart_price_unavailable',
  });
  queryClient.setQueryData<Product[]>(queryKeys.products.all, (products) =>
    products?.map((product) => product.id === productId ? clear(product) : product),
  );
  queryClient.setQueryData<ProductWithStats>(queryKeys.products.detail(productId), (product) =>
    product ? clear(product) : product,
  );
}

/**
 * Drops the cached price and stock history of a product after an action that
 * recorded a new reading.
 *
 * The detail page pulls its history through `queryClient.fetchQuery`, which
 * resolves straight from the cache while the entry is still fresh. With a five
 * minute `staleTime` that meant refetching after "Refresh Price" handed back
 * exactly the rows the Price History tab was already showing, and the new price
 * only appeared after a full reload (issue #195). Marking the entries invalid
 * sends that fetch to the network again, and refetches the stock history tab
 * on the spot when it is the one on screen.
 */
export async function invalidateProductHistory(productId: number): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.priceHistoryAll(productId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.stockHistoryAll(productId) }),
  ]);
}
