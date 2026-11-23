import { describe, expect, it, vi } from 'vitest';
import type { BrowserSession, ScraperPage } from '../../../scraper/src/types';

vi.mock('../../../scraper/src/core/Actions', () => ({
  performHumanLikeActions: vi.fn(),
}));

import { ScraperService } from '../../../scraper/src/services/ScraperService';

describe('Firefox page headers', () => {
  it('closes a page created after cancellation without preparing or navigating it', async () => {
    let finish!: (page: ScraperPage) => void;
    const newPage = vi.fn(() => new Promise<ScraperPage>(resolve => { finish = resolve; }));
    const close = vi.fn().mockResolvedValue(undefined);
    const page = { close, goto: vi.fn(), setViewport: vi.fn() } as unknown as ScraperPage;
    const session = { browserEngine: 'firefox', browser: { newPage } } as unknown as BrowserSession;
    const abort = new AbortController();
    const scrape = ScraperService.scrape('https://example.test/product', session, {}, abort.signal);
    abort.abort();
    await expect(scrape).resolves.toBeNull();
    expect(close).not.toHaveBeenCalled();
    finish(page);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(close).toHaveBeenCalledOnce();
    expect(page.goto).not.toHaveBeenCalled();
    expect(page.setViewport).not.toHaveBeenCalled();
  });
  it.each([
    [{ acceptLanguage: 'fr-FR,fr;q=0.9' }, { 'Accept-Language': 'fr-FR,fr;q=0.9' }],
    [{ referrer: 'https://example.test/', acceptLanguage: 'fr-FR' }, { Referer: 'https://example.test/', 'Accept-Language': 'fr-FR' }],
  ])('applies the requested headers together', async (options, headers) => {
    const page = {
      setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
      setViewport: vi.fn().mockResolvedValue(undefined),
      goto: vi.fn().mockResolvedValue(undefined),
      title: vi.fn().mockResolvedValue('Product'),
      content: vi.fn().mockResolvedValue('<html>Product</html>'),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const session = {
      browserEngine: 'firefox',
      browser: { newPage: async () => page as unknown as ScraperPage },
    } as unknown as BrowserSession;

    await ScraperService.scrape('https://example.test/product', session, options);

    expect(page.setExtraHTTPHeaders).toHaveBeenCalledOnce();
    expect(page.setExtraHTTPHeaders).toHaveBeenCalledWith(headers);
  });
});
