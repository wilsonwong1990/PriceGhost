import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { sessions } from '../../../scraper/src/core/SessionManager';
import type { BrowserSession, ScrapeResult } from '../../../scraper/src/types';
import { BrowserLaunchError, TargetSessionEngineMismatchError } from '../../../scraper/src/core/engine';

/**
 * The scrape route's session lifecycle (issues #254, #255).
 *
 * This drives the real Express route over a real socket, with the browser
 * behind it faked, because the two things being asserted are both wiring: that
 * an aborted or protocol-errored scrape retires its session instead of
 * returning it to the warm pool, and that a wall page is not announced as a
 * success.
 */

const { scrape, releaseSession, acquireSession, acquired } = vi.hoisted(() => {
  const acquired = { session: null as BrowserSession | null };
  return {
    scrape: vi.fn(),
    releaseSession: vi.fn().mockResolvedValue(undefined),
    acquireSession: vi.fn(async (_options: unknown, _signal: AbortSignal) => acquired.session),
    acquired,
  };
});

vi.mock('../../../scraper/src/services/ScraperService', () => ({
  ScraperService: { scrape },
}));

vi.mock('../../../scraper/src/services/SessionService', () => ({
  SessionService: {
    acquireSession,
    releaseSession,
    getPoolStatus: () => ({ activeSessions: sessions.length, maxBrowsers: 3, totalActivePages: 0, sessions: [] }),
  },
}));

const logLines: string[] = [];
vi.mock('../../../scraper/src/utils/logger', () => ({
  log: (message: string, type = 'INFO') => {
    logLines.push(`${type} ${message}`);
  },
}));

const fakeSession = (): BrowserSession => ({
  id: 'session_1791872680287_335',
  browser: null,
  launchPromise: null,
  activePages: 1,
  totalScrapes: 1,
  idleTimer: null,
  proxyUrl: 'http://scraper:pa55word@192.168.50.200:8888',
  userAgent: null,
  browserEngine: 'chromium',
  lastActivity: Date.now(),
  userDataDir: null,
  tainted: false,
  taintReason: null,
});

const result = (over: Partial<ScrapeResult> = {}): ScrapeResult => ({
  html: '<html><body>product</body></html>',
  screenshotBase64: null,
  challengeDetected: false,
  challengeUnresolved: false,
  browserEngine: 'chromium',
  ...over,
});

let server: Server;
let baseUrl: string;

beforeEach(async () => {
  logLines.length = 0;
  vi.clearAllMocks();
  releaseSession.mockResolvedValue(undefined);
  acquired.session = fakeSession();

  const router = (await import('../../../scraper/src/api/routes')).default;
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/', router);

  server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

const postScrape = (body: unknown, init: RequestInit = {}) =>
  fetch(`${baseUrl}/scrape`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  });

describe('a completed scrape keeps its session (issue #254)', () => {
  it('returns a healthy session to the warm pool', async () => {
    scrape.mockResolvedValue(result());

    const response = await postScrape({ url: 'https://www.bigw.com.au/product/x/p/1' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ challengeUnresolved: false });
    expect(acquired.session?.tainted).toBe(false);
    expect(releaseSession).not.toHaveBeenCalled();
    if (acquired.session?.idleTimer) clearTimeout(acquired.session.idleTimer);
  });
});

describe('a wedged scrape retires its session (issue #254)', () => {
  it('does not scrape and releases a reservation after disconnect during acquisition', async () => {
    const abort = new AbortController();
    let finish!: (session: BrowserSession | null) => void;
    acquireSession.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const inflight = postScrape({ url: 'https://example.test/product' }, { signal: abort.signal }).catch(() => undefined);
    await vi.waitFor(() => expect(acquireSession).toHaveBeenCalled());
    abort.abort();
    await vi.waitFor(() => expect(acquireSession.mock.calls[0][1].aborted).toBe(true));
    finish(acquired.session);
    await inflight;
    await vi.waitFor(() => expect(acquired.session?.activePages).toBe(0));
    expect(acquired.session?.totalScrapes).toBe(0);
    expect(acquired.session?.tainted).toBe(false);
    expect(scrape).not.toHaveBeenCalled();
    if (acquired.session?.idleTimer) clearTimeout(acquired.session.idleTimer);
  });
  it('discards the session when the client disconnects mid-scrape', async () => {
    const abort = new AbortController();
    let resolveScrape: (() => void) | undefined;
    scrape.mockImplementation(
      () =>
        new Promise<null>(resolve => {
          resolveScrape = () => resolve(null);
        })
    );

    const inflight = postScrape(
      { url: 'https://www.bigw.com.au/product/mirabella-pumpkin-inflatable/p/6069020' },
      { signal: abort.signal }
    ).catch(() => undefined);

    // Wait until the handler is actually in the scrape before dropping the
    // connection, which is the sequence the trace on #254 shows.
    await vi.waitFor(() => expect(scrape).toHaveBeenCalled());
    abort.abort();
    await vi.waitFor(() => expect(acquired.session?.tainted).toBe(true));

    resolveScrape?.();
    await inflight;

    expect(acquired.session?.taintReason).toBe('scrape aborted by client disconnect');
    await vi.waitFor(() => expect(releaseSession).toHaveBeenCalledWith(acquired.session));
    expect(acquired.session?.idleTimer).toBeNull();
  });

  it('discards the session on a CDP protocol error', async () => {
    const wedged = new Error(
      "Network.enable timed out. Increase the 'protocolTimeout' setting in launch/connect calls for a higher timeout if needed."
    );
    wedged.name = 'ProtocolError';
    scrape.mockRejectedValue(wedged);

    const response = await postScrape({ url: 'https://www.bigw.com.au/product/x/p/1' });

    expect(response.status).toBe(500);
    expect(acquired.session?.tainted).toBe(true);
    expect(acquired.session?.taintReason).toContain('CDP protocol error');
    expect(releaseSession).toHaveBeenCalledWith(acquired.session);
  });

  it('keeps the session for an ordinary site failure', async () => {
    // A navigation timeout is the retailer being slow, not the browser being
    // broken. Recycling here would relaunch Chromium on every slow page.
    scrape.mockRejectedValue(new Error('Navigation timeout of 36000 ms exceeded'));

    const response = await postScrape({ url: 'https://www.bigw.com.au/product/x/p/1' });

    expect(response.status).toBe(500);
    expect(acquired.session?.tainted).toBe(false);
    expect(releaseSession).not.toHaveBeenCalled();
    if (acquired.session?.idleTimer) clearTimeout(acquired.session.idleTimer);
  });
});

describe('the route does not call a wall page a success (issue #255)', () => {
  it('logs an unresolved challenge as a warning', async () => {
    scrape.mockResolvedValue(
      result({ html: 'x'.repeat(37262), challengeDetected: true, challengeUnresolved: true })
    );

    const response = await postScrape({
      url: 'https://www.ebgames.com.au/product/nintendo-switch-2/330016',
    });

    expect(response.status).toBe(200);
    expect(logLines.some(line => line.startsWith('WARN Unresolved challenge wall returned:'))).toBe(true);
    expect(logLines.some(line => line.includes('Success:'))).toBe(false);
    if (acquired.session?.idleTimer) clearTimeout(acquired.session.idleTimer);
  });

  it('still logs a clean page as a success', async () => {
    scrape.mockResolvedValue(result({ html: 'x'.repeat(1621160) }));

    await postScrape({ url: 'https://www.bigw.com.au/product/x/p/1' });

    expect(logLines.some(line => line === 'INFO Success: https://www.bigw.com.au/product/x/p/1 (1621160 bytes)')).toBe(true);
    if (acquired.session?.idleTimer) clearTimeout(acquired.session.idleTimer);
  });
});

describe('the route never logs proxy credentials', () => {
  it('redacts them from the request and session lines', async () => {
    scrape.mockResolvedValue(result());

    await postScrape(
      { url: 'https://www.bigw.com.au/product/x/p/1', options: { proxyUrl: acquired.session?.proxyUrl } },
    );

    expect(logLines.some(line => line.includes('pa55word'))).toBe(false);
    expect(logLines.some(line => line.includes('[REDACTED]:[REDACTED]@192.168.50.200:8888'))).toBe(true);
    if (acquired.session?.idleTimer) clearTimeout(acquired.session.idleTimer);
  });
});

describe('the route resolves the browser engine before taking a session', () => {
  it('returns a conflict for a targeted session of another engine', async () => {
    acquireSession.mockRejectedValueOnce(new TargetSessionEngineMismatchError());
    const response = await postScrape({ url: 'https://example.test/product', options: { browserEngine: 'firefox', sessionId: 'target' } });
    expect(response.status).toBe(409);
    expect(scrape).not.toHaveBeenCalled();
  });
  it('rejects object values without invoking their toString property', async () => {
    const response = await postScrape({
      url: 'https://example.test/product',
      options: { browserEngine: { toString: null } },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Unknown browserEngine: {"toString":null}' });
    expect(acquireSession).not.toHaveBeenCalled();
  });

  it('answers 400 for an engine the scraper does not have', async () => {
    const response = await postScrape({
      url: 'https://www.bigw.com.au/product/x/p/1',
      options: { browserEngine: 'webkit' },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Unknown browserEngine: webkit' });
    expect(acquireSession).not.toHaveBeenCalled();
  });

  it('asks the pool for Chromium when the request names no engine', async () => {
    scrape.mockResolvedValue(result());

    await postScrape({ url: 'https://www.bigw.com.au/product/x/p/1' });

    expect(acquireSession).toHaveBeenCalledWith(expect.objectContaining({ browserEngine: 'chromium' }), expect.any(AbortSignal));
    if (acquired.session?.idleTimer) clearTimeout(acquired.session.idleTimer);
  });

  it('answers 500, not the retryable 503, when the browser cannot launch', async () => {
    // A missing Firefox binary is not a busy pool: retrying it three times
    // with backoff, as the backend does for 503, cannot succeed.
    acquireSession.mockRejectedValueOnce(
      new BrowserLaunchError('firefox', new Error('Browser was not found at the configured executablePath'))
    );

    const response = await postScrape({
      url: 'https://www.bigw.com.au/product/x/p/1',
      options: { browserEngine: 'firefox' },
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Could not launch firefox: Browser was not found at the configured executablePath',
    });
    expect(scrape).not.toHaveBeenCalled();
  });
});
