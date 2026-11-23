import { describe, expect, it, vi } from 'vitest';
import type { BrowserSession, ScraperPage } from '../../../scraper/src/types';

vi.mock('../../../scraper/src/core/Actions', () => ({
  performHumanLikeActions: vi.fn(),
}));

import { ScraperService } from '../../../scraper/src/services/ScraperService';

describe('Firefox page headers', () => {
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
