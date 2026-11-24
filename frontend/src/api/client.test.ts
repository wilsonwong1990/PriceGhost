import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './client';
import { ApiError } from './error';
import { queryClient } from './queryClient';
import { clearUnverifiedCartPrice, syncProductCaches } from './productCache';
import type { ItemWithListings, Product, ProductWithStats } from '../types/api';

const location = { origin: 'http://localhost', pathname: '/products', search: '', hash: '', href: '' };
const storage = new Map<string, string>();

const product: ProductWithStats = {
  id: 1, user_id: 1, url: 'https://example.test/product', name: 'Original', image_url: null,
  refresh_interval: 3600, last_checked: null, next_check_at: null, stock_status: 'in_stock',
  price_drop_threshold: null, target_price: null, notify_back_in_stock: false,
  ai_verification_disabled: false, ai_extraction_disabled: false, checking_paused: false,
  category: null, created_at: '2026-01-01T00:00:00Z', current_price: 10, member_price: null,
  original_price: null, currency: 'USD', converted_price: null, converted_currency: null,
  ai_status: null, stats: { min_price: 8, max_price: 12, avg_price: 10, price_count: 3 },
};

beforeEach(() => {
  vi.stubGlobal('window', { location });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});

afterEach(() => {
  storage.clear();
  location.href = '';
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe('api client', () => {
  it('returns decoded data and sends auth/query parameters', async () => {
    storage.set('token', 'token-value');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ enabled: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.get<{ enabled: boolean }>('/settings/discovery/status', { params: { q: 'test' } })).resolves.toEqual({ enabled: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/settings/discovery/status?q=test', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer token-value' }),
    }));
  });

  it('throws ApiError for an HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Conflict' }), { status: 409 })));
    await expect(api.post('/products', {})).rejects.toMatchObject({ status: 409, message: 'Conflict' } satisfies Partial<ApiError>);
  });

  it('merges a product mutation into caches without losing detail stats', () => {
    queryClient.setQueryData(['products'], [product]);
    queryClient.setQueryData(['products', product.id], product);
    const updated: Product = { ...product, name: 'Renamed' };

    syncProductCaches(updated);

    expect(queryClient.getQueryData<Product[]>(['products'])?.[0].name).toBe('Renamed');
    expect(queryClient.getQueryData<ProductWithStats>(['products', product.id])?.stats).toEqual(product.stats);
  });

  it('removes an unverified listing from grouped price comparisons immediately', () => {
    const cart = { ...product, converted_price: 10, converted_currency: 'USD', preferred_extraction_method: 'amazon-cart' };
    const other = { ...product, id: 2, current_price: 15, converted_price: 15, converted_currency: 'USD' };
    const item: ItemWithListings = {
      id: 1, name: 'Item', image_url: null, category: null, target_price: null,
      price_drop_threshold: null, notify_back_in_stock: false, listings: [cart, other],
      store_count: 2, best_price: 10, best_price_listing_ids: [1], all_tied: false,
      best_price_currency: 'USD', price_spread: 5, comparable_count: 2, excluded_count: 0, any_in_stock: true,
    };
    queryClient.setQueryData(['products'], [cart, other]);
    queryClient.setQueryData(['products', 1], cart);
    queryClient.setQueryData(['products', 'items'], [item]);
    clearUnverifiedCartPrice(1);
    const result = queryClient.getQueryData<ItemWithListings[]>(['products', 'items'])?.[0];
    expect(result).toMatchObject({
      best_price: 15, best_price_listing_ids: [2], comparable_count: 1, excluded_count: 1, price_spread: null,
    });

    expect(result?.listings[0]).toMatchObject({ current_price: null, converted_price: null, unavailable_reason: 'amazon_cart_price_unavailable' });
    expect(queryClient.getQueryData<Product[]>(['products'])?.[0].current_price).toBeNull();
    expect(queryClient.getQueryData<ProductWithStats>(['products', 1])?.current_price).toBeNull();
  });

  it('switches automatic comparison currency when the primary listing loses its price', () => {
    const cart = { ...product, is_primary: true, current_price: 10, currency: 'USD', converted_price: null };
    const other = { ...product, id: 2, is_primary: false, current_price: 15, currency: 'EUR', converted_price: null, created_at: '2026-01-03T00:00:00Z' };
    const older = { ...product, id: 3, is_primary: false, current_price: 5, currency: 'USD', converted_price: null, created_at: '2026-01-02T00:00:00Z' };
    const item: ItemWithListings = {
      id: 1, name: 'Item', image_url: null, category: null, target_price: null,
      price_drop_threshold: null, notify_back_in_stock: false, listings: [older, cart, other],
      store_count: 3, best_price: 5, best_price_listing_ids: [3], all_tied: false,
      best_price_currency: 'USD', price_spread: 5, comparable_count: 2, excluded_count: 1, any_in_stock: true,
    };
    queryClient.setQueryData(['profile'], { currency: null });
    queryClient.setQueryData(['products', 'items'], [item]);
    clearUnverifiedCartPrice(1);
    expect(queryClient.getQueryData<ItemWithListings[]>(['products', 'items'])?.[0]).toMatchObject({
      best_price: 15, best_price_currency: 'EUR', best_price_listing_ids: [2], comparable_count: 1,
    });
  });
});
