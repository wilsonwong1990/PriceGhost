import type { ItemWithListings, Product, ProductWithStats, UserProfile } from '../types/api';
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
  void queryClient.cancelQueries({ queryKey: queryKeys.products.all });
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
  queryClient.setQueryData<ItemWithListings[]>(queryKeys.products.items, (items) =>
    items?.map((item) => {
      if (!item.listings.some((listing) => listing.id === productId)) return item;
      const listings = item.listings.map((listing) => listing.id === productId ? clear(listing) : listing);
      const profile = queryClient.getQueryData<UserProfile>(queryKeys.profile);
      const sourceOrder = [...listings].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      const primary = sourceOrder.find((listing) => listing.is_primary) ?? sourceOrder[0];
      const fallback = sourceOrder.find((listing) => listing.currency);
      const ambiguousFallback = fallback && sourceOrder.some((listing) =>
        listing !== fallback && listing.created_at === fallback.created_at &&
        listing.currency && listing.currency !== fallback.currency);
      const currency = profile?.currency === null
        ? primary?.currency || (ambiguousFallback ? null : fallback?.currency) || null
        : profile?.currency || item.best_price_currency;
      const prices = listings.flatMap((listing) => {
        const price = profile?.currency === null
          ? listing.currency === currency ? listing.current_price : null
          : listing.converted_price;
        return typeof price === 'number' && Number.isFinite(price) ? [{ id: listing.id, price }] : [];
      });
      const best = prices.length ? Math.min(...prices.map((entry) => entry.price)) : null;
      const worst = prices.length ? Math.max(...prices.map((entry) => entry.price)) : null;
      const spread = best !== null && worst !== null && prices.length > 1
        ? Math.round((worst - best) * 100) / 100 : null;
      return {
        ...item, listings, best_price: best,
        best_price_currency: best === null ? null : currency,
        best_price_listing_ids: best === null ? [] : prices.filter((entry) => entry.price === best).map((entry) => entry.id),
        comparable_count: prices.length, excluded_count: listings.length - prices.length,
        price_spread: spread, all_tied: prices.length > 1 && spread === 0,
        any_in_stock: listings.some((listing) =>
          listing.stock_status === 'in_stock' && listing.preferred_extraction_method !== 'amazon-cart'),
      };
    }),
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
