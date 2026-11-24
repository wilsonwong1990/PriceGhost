import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { Product } from '../../src/models/types';
import type { ScrapedProductWithVoting } from '../../src/types/scraper';
import type { UnavailableReason } from '../../src/types/availability';

/**
 * The other half of the `bot_or_challenge` fix (issue #67), asserted where the
 * damage was: `ProductRefreshService`.
 *
 * With no `unavailableReason`, a denied refresh is neither transient nor
 * definitive, so it fell into `else if (!reason)` -- the branch for a page that
 * was actually read -- and cleared the product's failure state. A retailer could
 * refuse every scheduled refresh forever: failure_streak stayed at zero,
 * `notifyNotAvailable` never fired, and the product page showed nothing at all.
 * The comment above that branch names "a bot challenge" among the transient
 * failures it counts. It did not count them.
 *
 * The first test here reproduces the old behaviour by returning no reason, which
 * is what the scraper used to return for a challenge. The rest assert the fix.
 */

const { repo, prices, persistence, notifications, scrape } = vi.hoisted(() => ({
  repo: {
    getPreferredExtractionMethod: vi.fn().mockResolvedValue(null),
    getAnchorPrice: vi.fn().mockResolvedValue(null),
    isAiVerificationDisabled: vi.fn().mockResolvedValue(true),
    isAiExtractionDisabled: vi.fn().mockResolvedValue(true),
    recordFailure: vi.fn().mockResolvedValue(1),
    clearFailureState: vi.fn().mockResolvedValue(undefined),
    setPageGoneStreak: vi.fn().mockResolvedValue(undefined),
    setUnavailableReason: vi.fn().mockResolvedValue(undefined),
    setPaused: vi.fn().mockResolvedValue(undefined),
    updateLastChecked: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  },
  prices: { getLatest: vi.fn().mockResolvedValue(null) },
  persistence: { saveScrapeResult: vi.fn().mockResolvedValue(null) },
  notifications: {
    notifyNotAvailable: vi.fn().mockResolvedValue(undefined),
    notifyBackInStock: vi.fn().mockResolvedValue(undefined),
    notifyProductRestored: vi.fn().mockResolvedValue(undefined),
    notifyPriceDrop: vi.fn().mockResolvedValue(undefined),
    notifyTargetHit: vi.fn().mockResolvedValue(undefined),
    notifyPriceAnnounced: vi.fn().mockResolvedValue(undefined),
  },
  scrape: vi.fn(),
}));

vi.mock('../../src/models', () => ({
  productRepository: repo,
  priceHistoryRepository: prices,
}));

vi.mock('../../src/services/scraper', () => ({ scrapeProductWithVoting: scrape }));

vi.mock('../../src/services/domain/product/ProductPersistenceService', () => ({
  productPersistenceService: persistence,
}));

vi.mock('../../src/services/domain/product/notifications/index', () => ({
  productNotificationService: notifications,
}));

vi.mock('../../src/utils/system/url-safety', () => ({
  assertUrlIsSafe: vi.fn().mockResolvedValue(undefined),
  UnsafeUrlError: class UnsafeUrlError extends Error {},
}));

vi.mock('../../src/utils/system/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

vi.mock('../../src/middleware/auth', () => ({
  authMiddleware: (req: { userId?: number }, _res: unknown, next: () => void) => {
    req.userId = 1;
    next();
  },
}));
vi.mock('../../src/middleware/scope', () => ({
  requireScopeByMethod: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../src/services/domain/product', async () => ({
  productHistoryService: { getProduct: vi.fn().mockImplementation(() => product({ url: 'https://www.amazon.com/dp/B012345678' })) },
  productRefreshService: (await import('../../src/services/domain/product/ProductRefreshService')).productRefreshService,
}));

const product = (over: Partial<Product> = {}): Product => ({
  id: 42,
  user_id: 1,
  url: 'https://www.target.com.au/p/thing/123',
  stock_status: 'in_stock',
  page_gone_streak: 0,
  checking_paused: false,
  auto_paused: false,
  ...over,
} as Product);

/** What the scraper returns for a denied page: no price, and a reason or not. */
const denied = (unavailableReason?: UnavailableReason): ScrapedProductWithVoting => ({
  name: null,
  price: null,
  imageUrl: null,
  url: 'https://www.target.com.au/p/thing/123',
  stockStatus: 'unknown',
  aiStatus: null,
  priceCandidates: [],
  needsReview: false,
  failureReason: 'bot_challenge',
  failureDetail: 'Akamai Behavioural Challenge',
  unavailableReason,
});

async function refresh(scraped: ScrapedProductWithVoting, over: Partial<Product> = {}) {
  scrape.mockResolvedValue(scraped);
  const { productRefreshService } = await import('../../src/services/domain/product/ProductRefreshService');
  await productRefreshService.refreshProduct(product(over));
}

describe('a denied refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repo.recordFailure.mockResolvedValue(1);
  });

  it('reschedules an ambiguous Amazon variant without persisting or notifying', async () => {
    const scraped = { ...denied(), failureReason: 'variant_selection_required' as const };
    await refresh(scraped, { stock_status: 'out_of_stock', checking_paused: true, auto_paused: true, refresh_interval: 3600 });
    expect(repo.updateLastChecked).toHaveBeenCalledWith(42, 3600);
    expect(repo.update).toHaveBeenCalledWith(42, 1, { needs_price_review: true });
    expect(repo.clearFailureState).not.toHaveBeenCalled();
    expect(repo.setPaused).not.toHaveBeenCalled();
    expect(persistence.saveScrapeResult).not.toHaveBeenCalled();
    expect(notifications.notifyProductRestored).not.toHaveBeenCalled();
    expect(notifications.notifyBackInStock).not.toHaveBeenCalled();
    expect(notifications.notifyPriceDrop).not.toHaveBeenCalled();
    expect(notifications.notifyTargetHit).not.toHaveBeenCalled();
  });

  it('used to clear the failure state, which is the bug', async () => {
    // The scraper's old return for a challenge: failureReason set, no
    // unavailableReason. Kept as a test so the shape of the fault stays on
    // record -- this is the branch that made a bot wall invisible.
    await refresh(denied(undefined));
    expect(repo.clearFailureState).toHaveBeenCalledWith(42);
    expect(repo.recordFailure).not.toHaveBeenCalled();
  });

  it('now counts the failure instead', async () => {
    await refresh(denied('bot_or_challenge'));
    expect(repo.recordFailure).toHaveBeenCalledWith(42, 'bot_or_challenge');
    expect(repo.clearFailureState).not.toHaveBeenCalled();
  });

  it('never marks the product gone or pauses it', async () => {
    // A bot check is not evidence the listing was removed.
    await refresh(denied('bot_or_challenge'));
    expect(repo.setPageGoneStreak).not.toHaveBeenCalled();
    expect(repo.setUnavailableReason).not.toHaveBeenCalled();
    expect(repo.setPaused).not.toHaveBeenCalled();
  });

  it('leaves the product status alone rather than writing unknown over it', async () => {
    await refresh(denied('bot_or_challenge'));
    const [, , scraped] = persistence.saveScrapeResult.mock.calls[0];
    expect((scraped as ScrapedProductWithVoting).stockStatus).toBe('unknown');
    // 'unknown' is what persistence declines to overwrite a known status with,
    // which is why the transient branch does not have to touch the status.
    expect(repo.setPaused).not.toHaveBeenCalled();
  });

  it('tells the user once, on the sixth consecutive denial', async () => {
    repo.recordFailure.mockResolvedValue(6);
    await refresh(denied('bot_or_challenge'));
    expect(notifications.notifyNotAvailable).toHaveBeenCalledTimes(1);
    const [, reason, definitive, failures] = notifications.notifyNotAvailable.mock.calls[0];
    expect(reason).toBe('bot_or_challenge');
    expect(definitive).toBe(false);
    expect(failures).toBe(6);
  });

  it('does not notify again after the threshold has passed', async () => {
    repo.recordFailure.mockResolvedValue(7);
    await refresh(denied('bot_or_challenge'));
    expect(notifications.notifyNotAvailable).not.toHaveBeenCalled();
  });

  it('still clears the failure state when a scrape really did read the page', async () => {
    const ok: ScrapedProductWithVoting = {
      ...denied(undefined),
      failureReason: undefined,
      failureDetail: undefined,
      stockStatus: 'in_stock',
      price: { price: 79, currency: 'AUD' },
    };
    await refresh(ok);
    expect(repo.clearFailureState).toHaveBeenCalledWith(42);
    expect(repo.recordFailure).not.toHaveBeenCalled();
  });
});

describe('Amazon cart refresh notifications', () => {
  const amazonUrl = 'https://www.amazon.com/dp/B012345678';
  const observation = {
    asin: 'B012345678',
    marketplace: 'amazon.com',
    condition: 'new',
    price: 249.99,
    currency: 'USD',
  } as const;

  beforeEach(() => {
    vi.clearAllMocks();
    persistence.saveScrapeResult.mockResolvedValue(null);
  });

  describe('Amazon cart refresh API', () => {
    let server: http.Server;
    let endpoint: string;

    beforeAll(async () => {
      const router = (await import('../../src/routes/prices')).default;
      const app = express();
      app.use(router);
      server = http.createServer(app);
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server did not bind');
      endpoint = `http://127.0.0.1:${address.port}/42/refresh`;
    });

    afterAll(async () => {
      if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('does not expose stale stock when a cart opt-in overtakes the refresh', async () => {
      scrape.mockResolvedValue({ ...denied(), stockStatus: 'in_stock', price: { price: 99, currency: 'USD' } });
      persistence.saveScrapeResult.mockResolvedValue({ stock: null, price: null, ignored: true });
      const response = await fetch(endpoint, { method: 'POST' });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ status: 'superseded', stockStatus: 'unknown' });
    });

    it('reports an unverified cart as unavailable rather than a successful refresh', async () => {
      scrape.mockResolvedValue({ ...denied('amazon_cart_price_unavailable'), amazonCartRequired: true });
      persistence.saveScrapeResult.mockResolvedValue({ stock: null, price: null, failureStreak: 1 });
      const response = await fetch(endpoint, { method: 'POST' });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        status: 'unavailable', stockStatus: 'unknown', error: 'Amazon cart price could not be verified.',
      });
    });
  });

  it('only reports an unverified cart as unavailable and never announces its page offer', async () => {
    persistence.saveScrapeResult.mockResolvedValue({
      stock: null, price: null, failureStreak: 6,
    });
    await refresh({
      ...denied('amazon_cart_price_unavailable'),
      url: amazonUrl,
      amazonCartRequired: true,
    }, { url: amazonUrl, target_price: 250, notify_back_in_stock: true });

    expect(repo.recordFailure).not.toHaveBeenCalled();
    expect(notifications.notifyNotAvailable).toHaveBeenCalledTimes(1);
    expect(notifications.notifyPriceDrop).not.toHaveBeenCalled();
    expect(notifications.notifyTargetHit).not.toHaveBeenCalled();
    expect(notifications.notifyBackInStock).not.toHaveBeenCalled();
  });

  it('compares only a transition persisted under the cart price basis', async () => {
    persistence.saveScrapeResult.mockResolvedValue({
      stock: null, price: { previousPrice: null, hadPreviousPrice: true, currentPrice: { price: 249.99, currency: 'USD' } },
    });
    await refresh({
      ...denied(),
      url: amazonUrl,
      failureReason: undefined,
      price: { price: 249.99, currency: 'USD' },
      amazonCartRequired: true,
      amazonCartObservation: observation,
    }, { url: amazonUrl, stock_status: 'pre_order', target_price: 250, price_drop_threshold: 5 });

    expect(notifications.notifyPriceDrop).not.toHaveBeenCalled();
    expect(notifications.notifyPriceAnnounced).not.toHaveBeenCalled();
    expect(notifications.notifyTargetHit).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42 }), null, { price: 249.99, currency: 'USD' }
    );
    expect(repo.clearFailureState).not.toHaveBeenCalled();
  });

  it('does not clear a newer Amazon failure outside the product lock when resuming', async () => {
    persistence.saveScrapeResult.mockResolvedValue({ stock: null, price: null });
    await refresh({
      ...denied(),
      url: amazonUrl,
      failureReason: undefined,
      stockStatus: 'in_stock',
      price: { price: 249.99, currency: 'USD' },
      amazonCartRequired: true,
      amazonCartObservation: observation,
    }, { url: amazonUrl, checking_paused: true, auto_paused: true });

    expect(repo.setPaused).toHaveBeenCalledWith(42, false, false);
    expect(repo.setUnavailableReason).not.toHaveBeenCalled();
  });

  it.each([true, false])('resumes only a system-paused cart product after recovery (auto-paused: %s)', async autoPaused => {
    persistence.saveScrapeResult.mockImplementationOnce(async (_id, _userId, scraped) => {
      scraped.stockStatus = 'unknown';
      return { stock: { from: 'not_available', to: 'unknown' }, price: null };
    });
    await refresh({
      ...denied(),
      url: amazonUrl,
      failureReason: undefined,
      stockStatus: 'unknown',
      price: { price: 249.99, currency: 'USD' },
      amazonCartRequired: true,
      amazonCartObservation: observation,
    }, {
      url: amazonUrl, stock_status: 'not_available', checking_paused: true, auto_paused: autoPaused,
      notify_back_in_stock: true,
    });
    if (autoPaused) {
      expect(repo.setPaused).toHaveBeenCalledWith(42, false, false);
      expect(notifications.notifyProductRestored).toHaveBeenCalledOnce();
    } else {
      expect(repo.setPaused).not.toHaveBeenCalled();
      expect(notifications.notifyProductRestored).not.toHaveBeenCalled();
    }
    expect(notifications.notifyBackInStock).not.toHaveBeenCalled();
  });

  it('does not notify or clear failures for a stale pre-cart scrape', async () => {
    persistence.saveScrapeResult.mockResolvedValue({ stock: null, price: null, ignored: true });
    await refresh({
      ...denied(),
      url: amazonUrl,
      failureReason: undefined,
      price: { price: 208, currency: 'USD' },
    }, { url: amazonUrl, target_price: 250 });
    expect(repo.clearFailureState).not.toHaveBeenCalled();
    expect(notifications.notifyTargetHit).not.toHaveBeenCalled();
  });

  it('does not announce a pre-order price when a prior price has a different currency', async () => {
    persistence.saveScrapeResult.mockResolvedValue({
      stock: null, price: { previousPrice: null, hadPreviousPrice: true, currentPrice: { price: 80, currency: 'USD' } },
    });
    await refresh({ ...denied(), failureReason: undefined, price: { price: 80, currency: 'USD' } },
      { stock_status: 'pre_order' });
    expect(notifications.notifyPriceAnnounced).not.toHaveBeenCalled();
  });

  it('still announces the first recorded pre-order price', async () => {
    persistence.saveScrapeResult.mockResolvedValue({
      stock: null, price: { previousPrice: null, hadPreviousPrice: false, currentPrice: { price: 80, currency: 'USD' } },
    });
    await refresh({ ...denied(), failureReason: undefined, price: { price: 80, currency: 'USD' } },
      { stock_status: 'pre_order' });
    expect(notifications.notifyPriceAnnounced).toHaveBeenCalledOnce();
  });
});

describe('page-gone streak debouncing and auto-pause recovery (commit 98c97da)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    persistence.saveScrapeResult.mockResolvedValue(null);
  });

  const gone = (reason: UnavailableReason = 'http_404'): ScrapedProductWithVoting => ({
    name: null,
    price: null,
    imageUrl: null,
    url: 'https://www.digitec.ch/en/s1/product/item-123',
    stockStatus: 'not_available',
    aiStatus: null,
    priceCandidates: [],
    needsReview: false,
    unavailableReason: reason,
  });

  it('holds the previous stock status on the first two 404s rather than pausing immediately', async () => {
    // Bot walls sometimes serve an unflagged 404 briefly; requiring 3
    // consecutive page-gone scrapes prevents a single blip from pausing
    // monitoring and alerting the user.
    await refresh(gone('http_404'), { stock_status: 'in_stock', page_gone_streak: 0 });
    expect(repo.setPageGoneStreak).toHaveBeenCalledWith(42, 1);
    expect(repo.setUnavailableReason).toHaveBeenCalledWith(42, 'http_404');
    const [, , firstScraped] = persistence.saveScrapeResult.mock.calls[0];
    expect((firstScraped as ScrapedProductWithVoting).stockStatus).toBe('in_stock');
    expect(repo.setPaused).not.toHaveBeenCalled();
    expect(notifications.notifyNotAvailable).not.toHaveBeenCalled();

    vi.clearAllMocks();
    await refresh(gone('http_404'), { stock_status: 'in_stock', page_gone_streak: 1 });
    expect(repo.setPageGoneStreak).toHaveBeenCalledWith(42, 2);
    const [, , secondScraped] = persistence.saveScrapeResult.mock.calls[0];
    expect((secondScraped as ScrapedProductWithVoting).stockStatus).toBe('in_stock');
    expect(repo.setPaused).not.toHaveBeenCalled();
    expect(notifications.notifyNotAvailable).not.toHaveBeenCalled();
  });

  it('marks the product not_available, pauses monitoring, and notifies on the third consecutive 404', async () => {
    persistence.saveScrapeResult.mockResolvedValueOnce({ stock: { from: 'in_stock', to: 'not_available' }, price: null });

    await refresh(gone('http_404'), { stock_status: 'in_stock', page_gone_streak: 2 });

    expect(repo.setPageGoneStreak).toHaveBeenCalledWith(42, 3);
    expect(repo.setUnavailableReason).toHaveBeenCalledWith(42, 'http_404');
    const [, , thirdScraped] = persistence.saveScrapeResult.mock.calls[0];
    expect((thirdScraped as ScrapedProductWithVoting).stockStatus).toBe('not_available');
    expect(repo.setPaused).toHaveBeenCalledWith(42, true, false);
    expect(notifications.notifyNotAvailable).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42 }),
      'http_404',
      true,
      3
    );
  });

  it('resets a non-zero page_gone_streak when a subsequent scrape succeeds', async () => {
    const recovered: ScrapedProductWithVoting = {
      ...gone(),
      unavailableReason: undefined,
      stockStatus: 'in_stock',
      price: { price: 79, currency: 'CHF' },
    };

    await refresh(recovered, { stock_status: 'in_stock', page_gone_streak: 2 });

    expect(repo.setPageGoneStreak).toHaveBeenCalledWith(42, 0);
    expect(repo.clearFailureState).toHaveBeenCalledWith(42);
  });

  it('resumes monitoring and notifies when an auto-paused product becomes available again', async () => {
    const recovered: ScrapedProductWithVoting = {
      ...gone(),
      unavailableReason: undefined,
      stockStatus: 'in_stock',
      price: { price: 79, currency: 'CHF' },
    };

    await refresh(recovered, {
      stock_status: 'not_available',
      checking_paused: true,
      auto_paused: true,
    });

    expect(repo.setPaused).toHaveBeenCalledWith(42, false, false);
    expect(repo.setUnavailableReason).toHaveBeenCalledWith(42, null);
    expect(notifications.notifyProductRestored).toHaveBeenCalledWith(expect.objectContaining({ id: 42 }));
  });

  it('does not unpause a product that the user manually paused', async () => {
    const recovered: ScrapedProductWithVoting = {
      ...gone(),
      unavailableReason: undefined,
      stockStatus: 'in_stock',
      price: { price: 79, currency: 'CHF' },
    };

    await refresh(recovered, {
      stock_status: 'in_stock',
      checking_paused: true,
      auto_paused: false,
    });

    expect(repo.setPaused).not.toHaveBeenCalled();
    expect(notifications.notifyProductRestored).not.toHaveBeenCalled();
  });
});
