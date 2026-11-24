import http from 'node:http';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import router from '../../../scraper/src/api/routes';
import { SessionService } from '../../../scraper/src/services/SessionService';

const token = 'test-token-for-cart-scraper-only-123456';

describe('Amazon cart endpoint authorization', () => {
  let server: http.Server;
  let endpoint: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json(), router);
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');
    endpoint = `http://127.0.0.1:${address.port}/amazon/cart-price`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  async function request(authorization?: string) {
    return fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
      body: JSON.stringify({
        url: 'https://www.amazon.com/dp/B012345678',
        options: { amazonCartMode: 'required' },
      }),
    });
  }

  it.each(['', 'short'])('does not open a browser without a configured secret', async configured => {
    vi.stubEnv('AMAZON_CART_SCRAPER_TOKEN', configured);
    const acquire = vi.spyOn(SessionService, 'acquireSession');
    expect((await request(`Bearer ${token}`)).status).toBe(503);
    expect(acquire).not.toHaveBeenCalled();
  });

  it.each([undefined, 'Bearer wrong-token', `Bearer ${token}x`])(
    'rejects unauthorized requests before acquiring a browser',
    async authorization => {
      vi.stubEnv('AMAZON_CART_SCRAPER_TOKEN', token);
      const acquire = vi.spyOn(SessionService, 'acquireSession');
      expect((await request(authorization)).status).toBe(401);
      expect(acquire).not.toHaveBeenCalled();
    }
  );

  it('accepts the configured token before acquiring a session', async () => {
    vi.stubEnv('AMAZON_CART_SCRAPER_TOKEN', token);
    const acquire = vi.spyOn(SessionService, 'acquireSession').mockResolvedValue(null);
    vi.spyOn(SessionService, 'getPoolStatus').mockReturnValue({
      activeSessions: 0, maxBrowsers: 0, activePages: 0, maxPagesPerBrowser: 0,
    } as ReturnType<typeof SessionService.getPoolStatus>);
    expect((await request(`Bearer ${token}`)).status).toBe(503);
    expect(acquire).toHaveBeenCalledOnce();
  });
});
