import express, { type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { log } from '../utils/logger.js';
import { ScraperService } from '../services/ScraperService.js';
import { SessionService } from '../services/SessionService.js';
import { IDLE_TIMEOUT, MAX_SCRAPES_PER_BROWSER, markSessionTainted } from '../core/SessionManager.js';
import { isProtocolError } from '../core/health.js';
import { scrapeOutcomeLog } from '../utils/outcome.js';
import type { BrowserSession, ScrapeOptions } from '../types.js';
import { errorMessage } from '../types.js';
import { scrubUrlCredentials } from '../utils/scrub.js';
import { amazonTarget } from '../services/AmazonCart.js';
import { BrowserLaunchError, TargetSessionEngineMismatchError, resolveBrowserEngine } from '../core/engine.js';

const router = express.Router();

// Scrape endpoint
async function handleScrape(req: Request, res: Response) {
  const { url, options = {} } = req.body as { url?: string; options?: ScrapeOptions };
  
  // Diagnostic log for identity debugging. The proxy URL carries inline
  // credentials in the usual deployment, so it is never logged raw.
  const proxyForLog = options.proxyUrl ? scrubUrlCredentials(options.proxyUrl) : 'None';
  log(`Incoming Scrape Request | URL: ${url} | UA: ${options.userAgent || 'None'} | Proxy: ${proxyForLog}`, 'INFO');

  const context = {
    requestId: options.requestId,
    productId: options.productId,
    forceDebug: (options.debug === true || process.env.DEBUG === 'true') && process.env.DEBUG !== 'false'
  };

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  const browserEngine = resolveBrowserEngine(options.browserEngine);
  if (!browserEngine) {
    const value = typeof options.browserEngine === 'string'
      ? options.browserEngine
      : JSON.stringify(options.browserEngine);
    return res.status(400).json({ error: `Unknown browserEngine: ${value}` });
  }

  const abortController = new AbortController();
  let session: BrowserSession | null = null;
  let scrapeStarted = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      log(`Client disconnected: ${url}. Aborting request.`, 'WARN', context);
      abortController.abort();
      if (session && scrapeStarted) markSessionTainted(session, 'scrape aborted by client disconnect');
    }
  });
  if (res.destroyed) abortController.abort();

  try {
    session = await SessionService.acquireSession({ ...options, browserEngine }, abortController.signal);
  } catch (error) {
    if (abortController.signal.aborted) return;
    if (error instanceof TargetSessionEngineMismatchError) return res.status(409).json({ error: error.message });
    if (!(error instanceof BrowserLaunchError)) throw error;
    log(`${error.message} for ${url}`, 'ERROR', context);
    return res.status(500).json({ error: error.message });
  }
  
  if (!session) {
    if (abortController.signal.aborted) return;
    const status = SessionService.getPoolStatus();
    log(`Rate limiting request: ${url} (All ${status.activeSessions} browsers busy)`, 'WARN', context);
    return res.status(503).json({ 
      error: 'Server busy. All browser instances at capacity. Please try again in a moment.' 
    });
  }

  session.lastActivity = Date.now();
  
  log(`Scraping: ${url} (Session: ${session.id}, Active: ${session.activePages}, Total: ${session.totalScrapes}) [Engine: ${session.browserEngine}, Proxy: ${proxyForLog}, UA: ${options.userAgent || 'None'}, Ref: ${options.referrer || 'None'}]`, 'INFO', context);

  try {
    if (abortController.signal.aborted) return;
    scrapeStarted = true;
    const result = await ScraperService.scrape(url, session, options, abortController.signal);
    
    if (abortController.signal.aborted) {
      log(`Scrape aborted for ${url}`, 'DEBUG', context);
      return;
    }

    if (!result) {
      throw new Error('Scrape failed or returned no data');
    }

    // Never "Success" for a wall page: the flag comes from what the scrape
    // observed on the live page, not from re-sniffing the HTML here (#255).
    const outcome = scrapeOutcomeLog(url, result);
    log(outcome.message, outcome.level, context);
    res.json(result);

  } catch (error) {
    // A CDP protocol failure means the DevTools connection, not the page, is
    // the problem, and the browser behind it is not safe to reuse (#254).
    if (isProtocolError(error)) {
      markSessionTainted(session, `CDP protocol error: ${scrubUrlCredentials(errorMessage(error))}`);
    }

    if (abortController.signal.aborted) {
      log(`Scrape aborted: ${url}`, 'DEBUG', context);
    } else {
      const message = scrubUrlCredentials(errorMessage(error));
      log(`Scrape Error: ${url} | ${message}`, 'ERROR', context);
      res.status(500).json({ error: message });
    }
  } finally {
    session.activePages--;
    if (!scrapeStarted) session.totalScrapes--;
    session.lastActivity = Date.now();

    if (session.activePages === 0) {
      if (session.tainted) {
        // Retired, not pooled. `releaseSession` goes through `closeSession`,
        // which still owns the profile-directory removal from issue #208.
        log(`Discarding session ${session.id}: ${session.taintReason || 'marked unusable'}`, 'WARN', context);
        await SessionService.releaseSession(session);
      } else if (session.totalScrapes >= MAX_SCRAPES_PER_BROWSER) {
        log(`Recycling exhausted session ${session.id}`, 'INFO', context);
        await SessionService.releaseSession(session);
      } else {
        session.idleTimer = setTimeout(async () => {
          if (session.activePages === 0) {
            log(`Closing idle session ${session.id} after ${IDLE_TIMEOUT/1000}s`, 'DEBUG', context);
            await SessionService.releaseSession(session);
          }
        }, IDLE_TIMEOUT);
      }
    }
  }
}

router.post('/scrape', async (req, res) => {
  if (req.body?.options?.amazonCartMode) {
    return res.status(400).json({ error: 'Amazon cart checks require the dedicated endpoint' });
  }
  return handleScrape(req, res);
});

router.post('/amazon/cart-price', async (req, res) => {
  const configuredToken = process.env.AMAZON_CART_SCRAPER_TOKEN;
  if (!configuredToken || Buffer.byteLength(configuredToken) < 32) {
    return res.status(503).json({ error: 'Amazon cart checks are not configured' });
  }
  const authorization = req.get('authorization');
  const supplied = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  const expectedBytes = Buffer.from(configuredToken);
  const suppliedBytes = Buffer.from(supplied);
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const target = typeof req.body?.url === 'string' ? amazonTarget(req.body.url) : null;
  const mode = req.body?.options?.amazonCartMode;
  if (!target || (mode !== 'auto' && mode !== 'required')) {
    return res.status(400).json({ error: 'A supported Amazon product URL and cart mode are required' });
  }
  req.body.url = target.productUrl;
  return handleScrape(req, res);
});

// Health check
router.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    pool: SessionService.getPoolStatus()
  });
});

export default router;
