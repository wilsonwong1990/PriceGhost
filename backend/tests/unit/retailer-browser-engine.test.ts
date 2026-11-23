import { describe, it, expect, vi, beforeEach } from 'vitest';
import { retailerRepository } from '../../src/models';
import { logger } from '../../src/utils/system/logger';
import { InvalidBrowserEngineError, RetailerMutationService } from '../../src/services/domain/retailer/RetailerMutationService';
import type { RetailerQueryService } from '../../src/services/domain/retailer/RetailerQueryService';

/**
 * Saving a retailer's browser engine.
 *
 * The column has a CHECK constraint, but a bad value reaching it would surface
 * as a generic 500. The service rejects it first, with a 400 the admin UI can
 * show, and leaves an omitted engine to the repository so the stored one is
 * kept.
 */

vi.mock('../../src/models', async () => ({
  ...(await import('../../src/models/types/retailer')),
  retailerRepository: { upsert: vi.fn() },
}));

vi.mock('../../src/utils/cache', () => ({
  configCache: { invalidate: vi.fn() },
}));

vi.mock('../../src/utils/system/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const service = new RetailerMutationService({} as RetailerQueryService);

describe('RetailerMutationService browser engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects an engine the scraper does not have with a 400', async () => {
    const save = service.upsertRetailer({ domain: 'example.com', browser_engine: 'webkit' });

    await expect(save).rejects.toBeInstanceOf(InvalidBrowserEngineError);
    await expect(save).rejects.toMatchObject({ statusCode: 400 });
    expect(retailerRepository.upsert).not.toHaveBeenCalled();
  });

  it('saves Firefox and records it in the audit trace', async () => {
    vi.mocked(retailerRepository.upsert).mockResolvedValue({
      domain: 'example.com',
      name: 'Example',
      active: true,
      use_browser_scraper: true,
      browser_engine: 'firefox',
    } as Awaited<ReturnType<typeof retailerRepository.upsert>>);

    await service.upsertRetailer({ domain: 'example.com', use_browser_scraper: true, browser_engine: 'firefox' });

    expect(retailerRepository.upsert).toHaveBeenCalledWith(expect.objectContaining({ browser_engine: 'firefox' }));
    const [, , meta] = vi.mocked(logger.info).mock.calls[0] as [string, string, { trace: string[] }];
    expect(meta.trace).toContain('Engine: Browser Scraper (firefox)');
  });

  it('passes an omitted engine through so the stored one is kept', async () => {
    vi.mocked(retailerRepository.upsert).mockResolvedValue({
      domain: 'example.com',
      use_browser_scraper: false,
      browser_engine: 'chromium',
    } as Awaited<ReturnType<typeof retailerRepository.upsert>>);

    await service.upsertRetailer({ domain: 'example.com' });

    expect(vi.mocked(retailerRepository.upsert).mock.calls[0][0]).not.toHaveProperty('browser_engine');
  });
});
