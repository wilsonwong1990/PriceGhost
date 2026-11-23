import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import puppeteer, { type Browser } from 'puppeteer';
import { scrapeAmazonCart } from '../../../scraper/src/services/AmazonCart';
import type { BrowserSession } from '../../../scraper/src/types';

const chromium = process.env.AMAZON_CART_CHROMIUM;
const describeBrowser = chromium ? describe : describe.skip;

describeBrowser('Amazon cart with an isolated local browser fixture', () => {
  let directory: string;
  let server: https.Server;
  let browser: Browser;
  let session: BrowserSession;
  let scenario: 'valid' | 'used' | 'different-offer' | 'conflicting-quantity' | 'conflicting-form-condition' | 'conflicting-form-root-condition' | 'conflicting-buybox-condition' | 'conflicting-outer-buybox-condition' | 'conflicting-cart-condition' | 'struck-only' | 'override-action' | 'override-encoding' | 'cross-origin-frame' | 'abort' | 'missing-404' | 'missing-410' | 'challenge-404';
  let requestStarted: (() => void) | undefined;
  const requests: { method: string | undefined; url: string | undefined; cookie: string | undefined }[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'amazon-cart-fixture-'));
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', path.join(directory, 'key.pem'),
      '-out', path.join(directory, 'cert.pem'),
      '-subj', '/CN=www.amazon.com', '-days', '1',
    ], { stdio: 'ignore' });
    server = https.createServer({
      key: await readFile(path.join(directory, 'key.pem')),
      cert: await readFile(path.join(directory, 'cert.pem')),
    }, (req, res) => {
      requests.push({ method: req.method, url: req.url, cookie: req.headers.cookie });
      if (req.method === 'GET' && req.url === '/dp/B012345678') {
        requestStarted?.();
        if (scenario === 'missing-404' || scenario === 'missing-410' || scenario === 'challenge-404') {
          res.writeHead(scenario === 'missing-410' ? 410 : 404, { 'content-type': 'text/html' });
          res.end(`${scenario === 'challenge-404' ? '<title>Are you a robot?</title>' : '<title>Product not found</title>'}
            <div id="buybox">Add to Cart to see price
              <form method="post" action="/gp/add-to-cart/html">
                <input name="ASIN.1" value="B012345678">
                <input name="offeringID.1" value="opaque-offer">
                <input name="quantity.1" value="1">
                <input name="condition" value="New">
                <input id="add-to-cart-button" type="submit" name="submit.add-to-cart" value="Add to Cart">
              </form>
            </div>`);
          return;
        }
        if (scenario === 'abort') {
          setTimeout(() => res.end('late response'), 500);
          return;
        }
        const condition = scenario === 'used' ? 'Used' : 'New';
        const conflictingCondition = scenario === 'conflicting-form-condition'
          ? '<span data-condition="Used">Used</span>' : '';
        const formCondition = scenario === 'conflicting-form-root-condition' ? 'data-condition="Used"' : '';
        const buyboxCondition = scenario === 'conflicting-buybox-condition'
          ? '<span id="buybox-condition">Used</span>' : '';
        const outerCondition = scenario === 'conflicting-outer-buybox-condition' ? 'data-condition="Used"' : '';
        const innerBuyboxStart = scenario === 'conflicting-outer-buybox-condition' ? '<div id="buybox">' : '';
        const innerBuyboxEnd = scenario === 'conflicting-outer-buybox-condition' ? '</div>' : '';
        const override = scenario === 'override-action' ? 'formaction="/checkout"' :
          scenario === 'override-encoding' ? 'formenctype="multipart/form-data"' : '';
        res.setHeader('content-type', 'text/html');
        res.setHeader('set-cookie', 'fixture-session=temporary; Path=/; Secure');
        res.end(`<!doctype html><title>Fixture product</title>
          <span id="productTitle"> Fixture product </span>
          <img id="landingImage" src="https://m.media-amazon.com/images/I/fixture.jpg?session=discarded">
          <div id="desktop_buybox" ${outerCondition}>Add to Cart to see price
            ${innerBuyboxStart}
            ${buyboxCondition}
            <form method="post" action="/gp/add-to-cart/html" ${formCondition}>
              <input name="ASIN.1" value="B012345678">
              <input name="offeringID.1" value="opaque-offer">
              <input name="quantity.1" value="1">
              <input name="condition" value="${condition}">
              ${conflictingCondition}
              <input id="add-to-cart-button" type="submit" name="submit.add-to-cart" value="Add to Cart" ${override}>
            </form>
            ${innerBuyboxEnd}
          </div>
          <img src="/gp/aws/cart/add.html?ASIN.1=B012345678&amp;Quantity.1=1">
          <iframe src="${scenario === 'cross-origin-frame' ? 'https://outside.test/frame' : '/checkout'}"></iframe>`);
      } else if (req.method === 'GET' && req.url === '/frame') {
        res.setHeader('content-type', 'text/html');
        res.end(`<script>fetch('https://www.amazon.com/checkout', {method: 'POST', mode: 'no-cors'}).catch(() => {})</script>`);
      } else if (req.method === 'POST' && req.url === '/gp/add-to-cart/html') {
        req.resume();
        res.writeHead(303, { location: '/gp/cart/view.html?session=discarded' });
        res.end();
      } else if (req.method === 'GET' && req.url === '/gp/cart/view.html') {
        const offer = scenario === 'different-offer' ? 'other-offer' : 'opaque-offer';
        const quantity = scenario === 'conflicting-quantity' ? '2' : '1';
        const price = scenario === 'struck-only'
          ? '<span class="sc-item-price"><del><span class="a-offscreen">$999.00</span></del></span>'
          : '<span class="apex-price-to-pay-value"><span class="a-offscreen">$249.99</span><span aria-hidden="true">$249.99</span></span>';
        const conflictingCondition = scenario === 'conflicting-cart-condition'
          ? '<span class="sc-product-condition">Condition: Used</span>' : '';
        res.setHeader('content-type', 'text/html');
        res.end(`<!doctype html><title>Fixture cart</title><div id="sc-active-cart">
          <div class="sc-list-item" data-asin="B012345678" data-condition="New" data-encoded-offering="${offer}" data-quantity="${quantity}">
            <select name="quantity.1"><option value="1" selected>1</option></select>
            ${conflictingCondition}
            ${price}
          </div></div>`);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not bind a TCP port');
    browser = await puppeteer.launch({
      executablePath: chromium,
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
        '--no-proxy-server', '--disable-background-networking', '--disable-quic',
        `--host-resolver-rules=MAP www.amazon.com 127.0.0.1:${address.port}, MAP outside.test 127.0.0.1:${address.port}, MAP * ~NOTFOUND`,
      ],
    });
    session = {
      id: 'fixture', browser, launchPromise: null, activePages: 1, totalScrapes: 0,
      idleTimer: null, proxyUrl: null, userAgent: null, lastActivity: Date.now(),
      userDataDir: null, tainted: false, taintReason: null,
    };
    const page = await browser.newPage();
    await page.setCookie({ name: 'user-session', value: 'not-for-cart', url: 'https://www.amazon.com/' });
    await page.close();
  }, 60000);

  beforeEach(() => {
    scenario = 'valid';
    requests.length = 0;
    requestStarted = undefined;
  });

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('uses only an isolated new-item cart and blocks other network requests', async () => {
    const result = await scrapeAmazonCart('https://www.amazon.com/dp/B012345678?tag=discarded', session, {
      amazonCartMode: 'auto', timeout: 15000,
    });
    expect(result?.amazonCart).toEqual({
      required: true, status: 'verified', asin: 'B012345678', marketplace: 'amazon.com',
      condition: 'new', price: 249.99, currency: 'USD',
      metadata: { name: 'Fixture product', imageUrl: 'https://m.media-amazon.com/images/I/fixture.jpg' },
    });
    expect(result?.html).toBe('');
    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'GET /dp/B012345678', 'POST /gp/add-to-cart/html', 'GET /gp/cart/view.html',
    ]);
    expect(requests.every(request => !request.cookie?.includes('user-session'))).toBe(true);
    expect(browser.browserContexts()).toHaveLength(1);
  });

  it('blocks a cross-origin frame before it can send a checkout request', async () => {
    const control = await browser.newPage();
    try {
      await control.goto('https://outside.test/frame', { waitUntil: 'load' });
      await expect.poll(() => requests.some(request => request.method === 'POST' && request.url === '/checkout'))
        .toBe(true);
    } finally {
      await control.close();
    }

    requests.length = 0;
    scenario = 'cross-origin-frame';
    const result = await scrapeAmazonCart('https://www.amazon.com/dp/B012345678', session, {
      amazonCartMode: 'auto', timeout: 15000,
    });
    expect(result?.amazonCart).toMatchObject({ required: true, status: 'verified' });
    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'GET /dp/B012345678', 'POST /gp/add-to-cart/html', 'GET /gp/cart/view.html',
    ]);
  });

  it.each([
    ['missing-404', 404, false],
    ['missing-410', 410, false],
    ['challenge-404', 404, true],
  ] as const)('rejects unavailable product evidence for %s', async (value, _status, challenge) => {
    scenario = value;
    const result = await scrapeAmazonCart('https://www.amazon.com/dp/B012345678', session, {
      amazonCartMode: 'required', timeout: 15000,
    });
    expect(result?.challengeDetected).toBe(challenge);
    expect(result?.amazonCart).toEqual({ required: true, status: 'unavailable' });
    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual(['GET /dp/B012345678']);
  });

  it.each([
    'used', 'conflicting-form-condition', 'conflicting-form-root-condition', 'conflicting-buybox-condition',
    'conflicting-outer-buybox-condition',
    'override-action', 'override-encoding',
  ] as const)(
    'does not submit an unsafe %s form',
    async value => {
      scenario = value;
      const result = await scrapeAmazonCart('https://www.amazon.com/dp/B012345678', session, {
        amazonCartMode: 'auto', timeout: 15000,
      });
      expect(result?.amazonCart).toEqual({ required: true, status: 'unavailable' });
      expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual(['GET /dp/B012345678']);
      expect(browser.browserContexts()).toHaveLength(1);
    }
  );

  it('rejects a cart row whose offer differs from the submitted form', async () => {
    scenario = 'different-offer';
    const result = await scrapeAmazonCart('https://www.amazon.com/dp/B012345678', session, {
      amazonCartMode: 'auto', timeout: 15000,
    });
    expect(result?.amazonCart).toEqual({ required: true, status: 'unavailable' });
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
    expect(browser.browserContexts()).toHaveLength(1);
  });

  it('rejects conflicting cart quantity indicators', async () => {
    scenario = 'conflicting-quantity';
    const result = await scrapeAmazonCart('https://www.amazon.com/dp/B012345678', session, {
      amazonCartMode: 'auto', timeout: 15000,
    });
    expect(result?.amazonCart).toEqual({ required: true, status: 'unavailable' });
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
    expect(browser.browserContexts()).toHaveLength(1);
  });

  it('rejects conflicting cart condition indicators', async () => {
    scenario = 'conflicting-cart-condition';
    const result = await scrapeAmazonCart('https://www.amazon.com/dp/B012345678', session, {
      amazonCartMode: 'auto', timeout: 15000,
    });
    expect(result?.amazonCart).toEqual({ required: true, status: 'unavailable' });
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
  });

  it('does not treat a struck-through price inside a price container as the cart price', async () => {
    scenario = 'struck-only';
    const result = await scrapeAmazonCart('https://www.amazon.com/dp/B012345678', session, {
      amazonCartMode: 'auto', timeout: 15000,
    });
    expect(result?.amazonCart).toEqual({ required: true, status: 'unavailable' });
    expect(browser.browserContexts()).toHaveLength(1);
  });

  it('closes the anonymous context when a request is aborted', async () => {
    scenario = 'abort';
    const started = new Promise<void>(resolve => { requestStarted = resolve; });
    const controller = new AbortController();
    const pending = scrapeAmazonCart('https://www.amazon.com/dp/B012345678', session, {
      amazonCartMode: 'required', timeout: 15000,
    }, controller.signal);
    await Promise.race([started, pending.then(() => { throw new Error('Scrape ended before the fixture request'); })]);
    controller.abort();
    const result = await pending.catch(error => {
      expect(error).toBeInstanceOf(Error);
      return null;
    });
    expect(result).toBeNull();
    expect(browser.browserContexts()).toHaveLength(1);
  });
});
