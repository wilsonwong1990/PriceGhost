import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { BrowserEngineMismatchError, fetchRemoteHtml, fetchRemoteScrape, RemoteCartCapabilityUnavailable } from '../../src/services/scraper/transport/remote';
import { logger } from '../../src/utils/system/logger';

vi.mock('axios');
vi.mock('../../src/utils/system/logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('fetchRemoteHtml', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubEnv('AMAZON_CART_SCRAPER_TOKEN', 'test-token-for-cart-scraper-only-123456');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('successfully fetches HTML on 200 response', async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: { html: '<html><body>Product Page</body></html>', amazonNetworkGuarded: true },
      status: 200,
    });

    const htmlPromise = fetchRemoteHtml('https://example.com/item', 'http://remotescraper:5100', {
      userAgent: 'CustomUA/1.0',
      productId: 42,
    });

    await expect(htmlPromise).resolves.toBe('<html><body>Product Page</body></html>');
    expect(axios.post).toHaveBeenCalledWith(
      'http://remotescraper:5100/scrape',
      expect.objectContaining({
        url: 'https://example.com/item',
        options: expect.objectContaining({
          userAgent: 'CustomUA/1.0',
          productId: 42,
        }),
      }),
      expect.objectContaining({
        // No options.timeout sent, so the 60s default plus 15s of overhead,
        // floored at the 70s minimum.
        timeout: 75000,
      })
    );
  });

  // The production path always sends both: `acquisition/remote.ts` and
  // `acquisition/fallback.ts` pass the `browser_timeout` and `browser_delay`
  // settings. The previous assertion exercised neither, so it could not have
  // caught the request timeout being too small to cover the scrape it was
  // waiting for.
  it('sizes the request timeout to cover the whole scrape budget the production path sends', async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: { html: '<html>ok</html>', amazonNetworkGuarded: true },
      status: 200,
    });

    await fetchRemoteHtml('https://example.com/item', 'http://remotescraper:5100', {
      userAgent: 'CustomUA/1.0',
      timeout: 60000,
      delay: 3000,
    });

    // 60s total scrape budget + 3s hydration delay + 15s of response overhead.
    // The old `+ 10000` gave 73s, which aborted a `page.goto` that succeeded
    // late in the window before the scraper could return its result.
    expect(axios.post).toHaveBeenCalledWith(
      'http://remotescraper:5100/scrape',
      expect.anything(),
      expect.objectContaining({ timeout: 78000 })
    );
  });

  it('never drops below the 70s floor for a small per-retailer timeout', async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: { html: '<html>ok</html>', amazonNetworkGuarded: true },
      status: 200,
    });

    await fetchRemoteHtml('https://example.com/item', 'http://remotescraper:5100', {
      timeout: 15000,
      delay: 0,
    });

    expect(axios.post).toHaveBeenCalledWith(
      'http://remotescraper:5100/scrape',
      expect.anything(),
      expect.objectContaining({ timeout: 70000 })
    );
  });

  it('throws descriptive configuration error when remote scraper URL returns 404 or 410', async () => {
    vi.mocked(axios.post).mockRejectedValueOnce({
      response: { status: 404, data: { error: 'Not Found' } },
      message: 'Request failed with status code 404',
    });

    const promise = fetchRemoteHtml('https://example.com/item', 'http://remotescraper:5100');
    await expect(promise).rejects.toThrow('Browser Scraper endpoint not found (404)');
  });

  it('retries on 503 Server Busy with backoff', async () => {
    vi.mocked(axios.post)
      .mockRejectedValueOnce({
        response: { status: 503, data: { error: 'Server busy' } },
        message: 'Request failed with status code 503',
      })
      .mockResolvedValueOnce({
        data: { html: '<html>Recovered</html>', amazonNetworkGuarded: true },
        status: 200,
      });

    const promise = fetchRemoteHtml('https://example.com/item', 'http://remotescraper:5100');

    // Advance timer for the first retry backoff (2^1 * 1000 = 2000ms)
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;
    expect(result).toBe('<html>Recovered</html>');
    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Busy | Retrying in 2000ms'),
      'Scraper'
    );
  });

  it('fails a Firefox request that an older scraper served with Chromium', async () => {
    // An older scraper image ignores `browserEngine` and reports no engine.
    // Accepting its page would hand back the wall Chromium was moved off.
    vi.mocked(axios.post).mockResolvedValueOnce({ data: { html: '<html>wall</html>' }, status: 200 });

    const promise = fetchRemoteHtml('https://example.com/item', 'http://remotescraper:5100', { browserEngine: 'firefox' });

    await expect(promise).rejects.toBeInstanceOf(BrowserEngineMismatchError);
    await expect(promise).rejects.toThrow('served no engine instead of the requested firefox');
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it('accepts a Firefox page the scraper reports serving with Firefox', async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: { html: '<html>product</html>', browserEngine: 'firefox' },
      status: 200,
    });

    await expect(
      fetchRemoteHtml('https://example.com/item', 'http://remotescraper:5100', { browserEngine: 'firefox' })
    ).resolves.toBe('<html>product</html>');
  });

  it('handles abort errors cleanly', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    vi.mocked(axios.post).mockRejectedValueOnce(abortError);

    const promise = fetchRemoteHtml('https://example.com/item', 'http://remotescraper:5100');
    await expect(promise).rejects.toThrow('Browser Scraper request aborted');
  });

  it('accepts ordinary browser responses without a cart guard', async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({ data: { html: '<html>unguarded</html>' } });
    await expect(fetchRemoteHtml('https://example.com/item', 'http://remotescraper:5100'))
      .resolves.toBe('<html>unguarded</html>');
    expect(axios.post).toHaveBeenCalledWith(
      'http://remotescraper:5100/scrape', expect.anything(), expect.anything()
    );
  });

  it('uses the dedicated Amazon endpoint and never retries a potentially mutating request', async () => {
    vi.mocked(axios.post).mockRejectedValueOnce({
      response: { status: 503, data: { error: 'Server busy' } },
      message: 'Server busy',
    });

    await expect(fetchRemoteScrape('https://www.amazon.com/dp/B012345678', 'http://remotescraper:5100/scrape', {
      amazonCartMode: 'auto',
    })).rejects.toThrow('Browser Scraper failed (503)');
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenCalledWith(
      'http://remotescraper:5100/amazon/cart-price',
      expect.objectContaining({ options: expect.objectContaining({ amazonCartMode: 'auto' }) }),
      expect.objectContaining({ headers: { Authorization: 'Bearer test-token-for-cart-scraper-only-123456' }, maxRedirects: 0 })
    );
  });

  it('fails before making a cart request when the secret is not configured', async () => {
    vi.stubEnv('AMAZON_CART_SCRAPER_TOKEN', '');
    await expect(fetchRemoteScrape('https://www.amazon.com/dp/B012345678', 'http://remotescraper:5100', {
      amazonCartMode: 'required',
    })).rejects.toBeInstanceOf(RemoteCartCapabilityUnavailable);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('treats a missing Amazon endpoint as an unsupported capability, not a missing product', async () => {
    vi.mocked(axios.post).mockRejectedValueOnce({
      response: { status: 404, data: { error: 'Not Found' } },
      message: 'Not Found',
    });
    await expect(fetchRemoteScrape('https://www.amazon.com/dp/B012345678', 'http://remotescraper:5100', {
      amazonCartMode: 'required',
    })).rejects.toBeInstanceOf(RemoteCartCapabilityUnavailable);
  });

  it('preserves challenge evidence from the Amazon endpoint', async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: { browserEngine: 'chromium', amazonCart: { required: true, status: 'unavailable' }, challengeDetected: false },
    });
    const result = await fetchRemoteScrape('https://www.amazon.com/dp/B012345678', 'http://remotescraper:5100', {
      amazonCartMode: 'required',
    });
    expect(result.challengeDetected).toBe(false);
  });

  it.each([undefined, 'firefox', 'webkit', 1])('requires a confirmed Chromium receipt for a default cart check: %s', async browserEngine => {
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: { browserEngine, challengeDetected: false, amazonCart: { required: true, status: 'verified' } },
    });
    await expect(fetchRemoteScrape('https://www.amazon.com/dp/B012345678', 'http://remotescraper:5100', {
      amazonCartMode: 'required',
    })).rejects.toBeInstanceOf(BrowserEngineMismatchError);
    expect(axios.post).toHaveBeenCalledOnce();
  });

  it.each([undefined, 'chromium'])('rejects cart evidence with an unexpected Firefox engine receipt: %s', async browserEngine => {
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: { browserEngine, challengeDetected: false, amazonCart: { required: true, status: 'verified' } },
    });
    await expect(fetchRemoteScrape('https://www.amazon.com/dp/B012345678', 'http://remotescraper:5100', {
      amazonCartMode: 'required', browserEngine: 'firefox',
    })).rejects.toBeInstanceOf(BrowserEngineMismatchError);
    expect(axios.post).toHaveBeenCalledOnce();
  });

  it('returns the confirmed Firefox engine on cart evidence', async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: { browserEngine: 'firefox', challengeDetected: false, amazonCart: { required: true, status: 'unavailable' } },
    });
    await expect(fetchRemoteScrape('https://www.amazon.com/dp/B012345678', 'http://remotescraper:5100', {
      amazonCartMode: 'required', browserEngine: 'firefox',
    })).resolves.toMatchObject({ browserEngine: 'firefox', challengeDetected: false });
    expect(axios.post).toHaveBeenCalledOnce();
  });

  it.each([
    {},
    { challengeDetected: 'false' },
    { challengeDetected: null },
    { challengeDetected: 0 },
  ])('does not trust missing or malformed challenge metadata', async metadata => {
    vi.mocked(axios.post).mockResolvedValueOnce({ data: { browserEngine: 'chromium', ...metadata } });
    const result = await fetchRemoteScrape('https://www.amazon.com/dp/B012345678', 'http://remotescraper:5100', {
      amazonCartMode: 'required',
    });
    expect(result.challengeDetected).toBeUndefined();
  });
});
