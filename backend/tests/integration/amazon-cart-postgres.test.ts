import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pool from '../../src/config/database';
import { productRepository } from '../../src/models';
import { productDashboardRepository } from '../../src/services/domain/product/repositories/product-dashboard.repository';
import { productPersistenceService } from '../../src/services/domain/product/ProductPersistenceService';
import type { ScrapedProductWithVoting } from '../../src/types/scraper';

vi.mock('../../src/services/domain/product/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/domain/product/utils')>();
  return { ...actual, runAutoRetailerConfig: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../src/utils/system/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const databaseUrl = process.env.AMAZON_CART_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

const base: ScrapedProductWithVoting = {
  name: null,
  imageUrl: null,
  url: 'https://www.amazon.com/dp/B012345678',
  stockStatus: 'in_stock',
  aiStatus: null,
  price: { price: 249.99, currency: 'USD' },
  priceCandidates: [],
  needsReview: false,
};
const verified: ScrapedProductWithVoting = {
  ...base,
  amazonCartRequired: true,
  selectedMethod: 'amazon-cart',
  amazonCartObservation: {
    asin: 'B012345678', marketplace: 'amazon.com', condition: 'new', price: 249.99, currency: 'USD',
  },
};
const failed: ScrapedProductWithVoting = {
  ...base,
  price: null,
  stockStatus: 'out_of_stock',
  needsReview: true,
  amazonCartRequired: true,
  unavailableReason: 'amazon_cart_price_unavailable',
};

describePostgres('Amazon cart persistence against PostgreSQL', () => {
  let userId: number;
  let productId: number;

  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBe(databaseUrl);
    const result = await pool.query<{ current_database: string }>('SELECT current_database()');
    expect(result.rows[0].current_database).toBe('amazon_cart_test');
  });

  beforeEach(async () => {
    const user = await pool.query<{ id: number }>(
      'INSERT INTO users (email, currency) VALUES ($1, $2) RETURNING id',
      [`cart-test-${randomUUID()}@example.invalid`, 'USD']
    );
    userId = user.rows[0].id;
    const item = await pool.query<{ id: number }>(
      'INSERT INTO items (user_id, name) VALUES ($1, $2) RETURNING id',
      [userId, 'Test product']
    );
    const product = await pool.query<{ id: number }>(
      `INSERT INTO products (user_id, item_id, url, name, stock_status)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [userId, item.rows[0].id, base.url, 'Test product', 'in_stock']
    );
    productId = product.rows[0].id;
    await pool.query(
      `INSERT INTO price_history (product_id, price, currency, price_type)
       VALUES ($1, $2, 'USD', 'standard')`,
      [productId, 208]
    );
  });

  afterEach(async () => {
    if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  it('creates an opted-in product with its cart requirement already set', async () => {
    const product = await productRepository.create(
      userId, 'https://www.amazon.com/dp/B000000001', 'Cart product', null,
      43200, 'unknown', null, null, 'amazon-cart'
    );
    const stored = await productRepository.findById(product.id, userId);
    expect(stored?.preferred_extraction_method).toBe('amazon-cart');
    const stale = await productPersistenceService.saveScrapeResult(product.id, userId, { ...base }, 'refresh');
    expect(stale?.ignored).toBe(true);
    expect((await productRepository.findById(product.id, userId))?.current_price).toBeNull();
  });

  it('fills only fallback item metadata from a later verified cart observation', async () => {
    const listing = await productRepository.create(
      userId, 'https://www.amazon.com/dp/B000000001', null, null,
      43200, 'unknown', null, null, 'amazon-cart'
    );
    const later = {
      ...verified,
      url: listing.url,
      name: 'Verified title',
      imageUrl: 'https://m.media-amazon.com/images/I/product.jpg',
      amazonCartObservation: { ...verified.amazonCartObservation!, asin: 'B000000001' },
    };
    await productPersistenceService.saveScrapeResult(listing.id, userId, later, 'refresh');
    let result = await pool.query(
      'SELECT i.name, i.image_url FROM items i JOIN products p ON p.item_id = i.id WHERE p.id = $1',
      [listing.id]
    );
    expect(result.rows[0]).toEqual({
      name: 'Verified title', image_url: 'https://m.media-amazon.com/images/I/product.jpg',
    });

    await pool.query(
      `UPDATE items SET name = 'Custom name', image_url = 'https://example.test/custom.jpg'
       WHERE id = (SELECT item_id FROM products WHERE id = $1)`, [listing.id]
    );
    await pool.query('UPDATE products SET image_url = $1 WHERE id = $2', ['https://example.test/listing.jpg', listing.id]);
    await productPersistenceService.saveScrapeResult(listing.id, userId, {
      ...later, name: 'Different title', imageUrl: 'https://m.media-amazon.com/images/I/other.jpg',
    }, 'refresh');
    result = await pool.query(
      'SELECT i.name, i.image_url FROM items i JOIN products p ON p.item_id = i.id WHERE p.id = $1',
      [listing.id]
    );
    expect(result.rows[0]).toEqual({ name: 'Custom name', image_url: 'https://example.test/custom.jpg' });
    expect((await productRepository.findById(listing.id, userId))?.image_url).toBe('https://example.test/listing.jpg');
  });

  it('ignores only the synthetic Amazon marker in duplicate lookups', async () => {
    await pool.query('UPDATE products SET url = $1 WHERE id = $2', [`${base.url}#unverified-amazon-selection`, productId]);
    expect(await productRepository.findDuplicateUrl(base.url, userId)).toBe(productId);
    expect(await productRepository.findDuplicateUrl(`${base.url}#unverified-amazon-selection`, userId)).toBe(productId);
    expect(await productRepository.findDuplicateUrl('https://www.amazon.com.au/dp/B012345678', userId)).toBeNull();
    expect(await productRepository.findDuplicateUrl(`${base.url}?seller=other`, userId)).toBeNull();
    expect(await productRepository.findDuplicateUrl(base.url, userId + 999999)).toBeNull();
    await pool.query('UPDATE products SET url = $1 WHERE id = $2', ['https://www.amazon.com/dp/b012345678', productId]);
    expect(await productRepository.findDuplicateUrl(base.url, userId)).toBe(productId);
  });

  it('does not let an older failed confirmation hide a newer successful refresh', async () => {
    const snapshot = (await productRepository.findById(productId, userId))?.last_checked ?? null;
    await productPersistenceService.saveScrapeResult(productId, userId, { ...verified }, 'refresh');
    await productPersistenceService.rememberAmazonCartRequirement(
      productId, userId, 'amazon_cart_price_unavailable', snapshot
    );
    const current = await productRepository.findById(productId, userId);
    expect(current?.current_price).toBe(249.99);
    expect(current?.unavailable_reason).toBeNull();
  });

  it('keeps earlier offer prices in history but excludes them from current and minimum cart prices', async () => {
    const transition = await productPersistenceService.saveScrapeResult(productId, userId, { ...verified }, 'refresh');
    expect(transition?.price).toEqual({ previousPrice: null, hadPreviousPrice: true, currentPrice: { price: 249.99, currency: 'USD' } });

    const product = await productRepository.findById(productId, userId);
    expect(product?.current_price).toBe(249.99);
    expect(product?.min_price).toBe(249.99);
    const dashboard = await productDashboardRepository.findByUserIdWithSparkline(userId);
    expect(dashboard[0].current_price).toBe(249.99);
    expect(dashboard[0].min_price).toBe(249.99);
    expect(dashboard[0].sparkline).toHaveLength(1);
    const history = await pool.query('SELECT price, details FROM price_history WHERE product_id = $1 ORDER BY id', [productId]);
    expect(history.rows.map(row => row.price)).toEqual([208, 249.99]);
    expect(history.rows[1].details.price_basis).toBe('amazon-cart-new');
  });

  it('hides a stale cart price without changing stock on an unverified result', async () => {
    await productPersistenceService.saveScrapeResult(productId, userId, { ...verified }, 'refresh');
    await productPersistenceService.saveScrapeResult(productId, userId, {
      ...verified,
      price: { price: 229.99, currency: 'USD' },
      amazonCartObservation: { ...verified.amazonCartObservation!, price: 229.99 },
    }, 'refresh');
    const transition = await productPersistenceService.saveScrapeResult(productId, userId, { ...failed }, 'refresh');
    expect(transition?.stock).toBeNull();
    expect(transition?.price).toBeNull();
    expect(transition?.failureStreak).toBe(1);
    const product = await productRepository.findById(productId, userId);
    expect(product?.current_price).toBeNull();
    expect(product?.min_price).toBe(229.99);
    expect(product?.stock_status).toBe('in_stock');
    expect(product?.unavailable_reason).toBe('amazon_cart_price_unavailable');
    const dashboard = await productDashboardRepository.findByUserIdWithSparkline(userId);
    expect(dashboard[0].current_price).toBeNull();
    expect(dashboard[0].min_price).toBe(229.99);
    expect(dashboard[0].sparkline.map(point => point.price)).toEqual([249.99, 229.99]);
    expect(dashboard[0].price_change_7d).toBeNull();
  });

  it('keeps the previous stock observation when a successful cart check cannot verify stock', async () => {
    await pool.query(`UPDATE products SET stock_status = 'out_of_stock' WHERE id = $1`, [productId]);
    const transition = await productPersistenceService.saveScrapeResult(productId, userId, {
      ...verified, stockStatus: 'in_stock',
    }, 'refresh');
    expect(transition?.stock).toBeNull();
    const product = await productRepository.findById(productId, userId);
    expect(product?.current_price).toBe(249.99);
    expect(product?.stock_status).toBe('out_of_stock');
    expect(product?.unavailable_reason).toBeNull();
  });

  it('preserves the page-gone streak when a cart check is unverified', async () => {
    await productPersistenceService.saveScrapeResult(productId, userId, { ...verified }, 'refresh');
    const gone: ScrapedProductWithVoting = {
      ...failed, stockStatus: 'not_available', unavailableReason: 'http_404',
    };
    await productPersistenceService.saveScrapeResult(productId, userId, { ...gone }, 'refresh');
    await productPersistenceService.saveScrapeResult(productId, userId, { ...gone }, 'refresh');
    expect((await productRepository.findById(productId, userId))?.page_gone_streak).toBe(2);

    await productPersistenceService.saveScrapeResult(productId, userId, { ...failed }, 'refresh');
    expect((await productRepository.findById(productId, userId))?.page_gone_streak).toBe(2);

  });

  it('clears a gone status to unknown after a verified cart without asserting stock', async () => {
    await pool.query(`UPDATE products SET stock_status = 'not_available', page_gone_streak = 3 WHERE id = $1`, [productId]);
    const transition = await productPersistenceService.saveScrapeResult(productId, userId, { ...verified }, 'refresh');
    const product = await productRepository.findById(productId, userId);
    expect(transition?.stock).toEqual({ from: 'not_available', to: 'unknown' });
    expect(product?.stock_status).toBe('unknown');
    expect(product?.page_gone_streak).toBe(0);
    expect(product?.current_price).toBe(249.99);
  });

  it('ignores a stale ordinary scrape that finishes after the cart requirement was saved', async () => {
    await productPersistenceService.saveScrapeResult(productId, userId, { ...verified }, 'refresh');
    const stale = await productPersistenceService.saveScrapeResult(
      productId, userId, { ...base, price: { price: 208, currency: 'USD' }, selectedMethod: 'json-ld' }, 'refresh'
    );
    expect(stale?.ignored).toBe(true);
    const product = await productRepository.findById(productId, userId);
    expect(product?.preferred_extraction_method).toBe('amazon-cart');
    expect(product?.current_price).toBe(249.99);
  });

  it('remembers a rescan requirement without allowing a stale page price to restore the old basis', async () => {
    await productPersistenceService.rememberAmazonCartRequirement(productId, userId);
    const product = await productRepository.findById(productId, userId);
    expect(product?.preferred_extraction_method).toBe('amazon-cart');
    expect(product?.current_price).toBeNull();
    expect(product?.needs_price_review).toBe(true);

    const stale = await productPersistenceService.saveScrapeResult(productId, userId, { ...base }, 'refresh');
    expect(stale?.ignored).toBe(true);
    await productPersistenceService.saveScrapeResult(productId, userId, { ...verified }, 'refresh');
    expect((await productRepository.findById(productId, userId))?.needs_price_review).toBe(false);
    await productPersistenceService.rememberAmazonCartRequirement(productId, userId);
    expect((await productRepository.findById(productId, userId))?.current_price).toBe(249.99);
    await productPersistenceService.rememberAmazonCartRequirement(productId, userId, 'amazon_cart_price_unavailable');
    const failedRescan = await productRepository.findById(productId, userId);
    expect(failedRescan?.current_price).toBeNull();
    expect(failedRescan?.stock_status).toBe('in_stock');
    expect(failedRescan?.unavailable_reason).toBe('amazon_cart_price_unavailable');
  });

  it.each([
    ['failure then success', true],
    ['success then failure', false],
  ])('keeps failure state consistent when concurrent refreshes complete in order: %s', async (_label, failureFirst) => {
    await productPersistenceService.saveScrapeResult(productId, userId, { ...verified }, 'refresh');
    const blocker = await pool.connect();
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    let committed = false;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock($1)', [productId]);
      first = productPersistenceService.saveScrapeResult(
        productId, userId, { ...(failureFirst ? failed : verified) }, 'refresh'
      );
      await waitForAdvisoryWaiters(productId, 1);
      second = productPersistenceService.saveScrapeResult(
        productId, userId, { ...(failureFirst ? verified : failed) }, 'refresh'
      );
      await waitForAdvisoryWaiters(productId, 2);
      await blocker.query('COMMIT');
      committed = true;
    } finally {
      if (!committed) await blocker.query('ROLLBACK');
      blocker.release();
    }
    await Promise.all([first, second]);
    const product = await productRepository.findById(productId, userId);
    expect(product?.unavailable_reason).toBe(failureFirst ? null : 'amazon_cart_price_unavailable');
    expect(product?.failure_streak).toBe(failureFirst ? 0 : 1);
    expect(product?.current_price).toBe(failureFirst ? 249.99 : null);
    expect(product?.stock_status).toBe('in_stock');
  });
});

async function waitForAdvisoryWaiters(productId: number, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_locks
       WHERE locktype = 'advisory' AND objid = $1 AND NOT granted`,
      [productId]
    );
    if (result.rows[0].count >= expected) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${expected} advisory-lock waiter(s)`);
}
