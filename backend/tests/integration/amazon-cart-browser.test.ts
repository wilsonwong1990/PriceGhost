import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import puppeteer, { type Browser } from 'puppeteer';
import { amazonTarget, guardFirefoxAmazonRequest, scrapeAmazonCart, validateAmazonForm } from '../../../scraper/src/services/AmazonCart';
import { buildFirefoxPrefs } from '../../../scraper/src/core/engine';
import type { BrowserSession } from '../../../scraper/src/types';

const productUrl = 'https://www.amazon.com/dp/B012345678';
const offersPath = '/gp/product/ajax/aodAjaxMain/?asin=B012345678&pc=dp&experienceId=aodAjaxMain';
const addPath = '/cart/add-to-cart/ref=aod_dpdsk_new_0';
const offerFields: [string, string][] = [
  ['items[0.base][asin]', 'B012345678'],
  ['items[0.base][offerListingId]', 'opaque-offer'],
  ['items[0.base][quantity]', '1'],
];

for (const { browserEngine, executablePath } of [
  { browserEngine: 'chromium', executablePath: process.env.AMAZON_CART_CHROMIUM },
  { browserEngine: 'firefox', executablePath: process.env.AMAZON_CART_FIREFOX },
] as const) {
const describeBrowser = executablePath ? describe : describe.skip;
// Firefox over BiDi needs more than the 5s default for a full product, offers and cart sequence.
describeBrowser(`Amazon cart with an isolated ${browserEngine} fixture`, { timeout: 60000 }, () => {
  let directory: string;
  let server: https.Server;
  let proxy: http.Server;
  const tunnels = new Set<net.Socket>();
  let browser: Browser;
  let baseContexts: ReturnType<Browser['browserContexts']>;
  let controlBrowser: Browser;
  let session: BrowserSession;
  let scenario: 'valid' | 'used' | 'third-party' | 'different-offer' | 'conflicting-quantity' | 'duplicate-form-quantity' | 'conflicting-cart-condition' | 'struck-only' | 'override-action' | 'override-encoding' | 'cross-origin-frame' | 'abort' | 'missing-404' | 'missing-410' | 'challenge-404' | 'offers-challenge' | 'redirect-replay' | 'live-shape' | 'target-blank' | 'base-target';
  let requestStarted: (() => void) | undefined;
  const requests: { method: string | undefined; url: string | undefined; cookie: string | undefined; body?: string }[] = [];

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
      const recorded = { method: req.method, url: req.url, cookie: req.headers.cookie, body: '' };
      requests.push(recorded);
      if (req.method === 'GET' && req.url === '/dp/B012345678') {
        requestStarted?.();
        if (scenario === 'missing-404' || scenario === 'missing-410' || scenario === 'challenge-404') {
          res.writeHead(scenario === 'missing-410' ? 410 : 404, { 'content-type': 'text/html' });
          res.end(`${scenario === 'challenge-404' ? '<title>Are you a robot?</title>' : '<title>Product not found</title>'}
            <div id="buybox">Add to Cart to see price</div>`);
          return;
        }
        if (scenario === 'abort') {
          setTimeout(() => res.end('late response'), 500);
          return;
        }
        res.setHeader('content-type', 'text/html');
        res.setHeader('set-cookie', 'fixture-session=temporary; Path=/; Secure');
        res.end(`<!doctype html><title>Fixture product</title>
          <span id="productTitle"> Fixture product </span>
          <img id="landingImage" src="https://m.media-amazon.com/images/I/fixture.jpg?session=discarded">
          <div id="desktop_buybox">Add to Cart to see price</div>
          <script>document.title = 'Unsafe script'; fetch('/checkout', {method: 'POST'})</script>
          <img src="/gp/aws/cart/add.html?ASIN.1=B012345678&amp;Quantity.1=1">
          <iframe src="${scenario === 'cross-origin-frame' ? 'https://outside.test/frame' : '/checkout'}"></iframe>`);
      } else if (req.method === 'GET' && req.url === offersPath) {
        res.setHeader('content-type', 'text/html');
        if (scenario === 'offers-challenge') {
          res.end('<title>Are you a robot?</title><form action="/errors_page/validateCaptcha"></form>');
          return;
        }
        // live-shape mirrors Amazon without scripts: blank quantity and a repeated form outside the offers.
        const fields: [string, string][] = scenario === 'live-shape'
          ? offerFields.map(([name, value]) => [name, name.endsWith('[quantity]') ? '' : value]) : [...offerFields];
        if (scenario === 'duplicate-form-quantity') fields.push(['items[0.base][quantity]', '2']);
        const repeated = scenario === 'live-shape'
          ? `<div id="aod-sticky"><form method="post" action="${addPath}"><input name="items[0.base][quantity]" value=""></form></div>` : '';
        res.end(`${scenario === 'base-target' ? '<base target="_blank">' : ''}${repeated}<section id="aod-offer">
          <div id="aod-offer-heading">${scenario === 'used' ? 'Used' : 'New'}</div>
          <div id="aod-offer-soldBy"><span class="a-color-base">${scenario === 'third-party' ? 'Another seller' : 'Amazon.com'}</span></div>
          <form method="post" action="${scenario === 'override-action' ? '/checkout' : addPath}"
            ${scenario === 'target-blank' ? 'target="_blank"' : ''}
            enctype="${scenario === 'override-encoding' ? 'multipart/form-data' : 'application/x-www-form-urlencoded'}">
            ${fields.map(([name, value]) => `<input name="${name}" value="${value}">`).join('')}
            <button>Add to cart</button>
          </form></section>`);
      } else if (req.method === 'GET' && req.url === '/seed') {
        res.setHeader('content-type', 'text/html');
        res.end('<title>Seed context</title>');
      } else if (req.method === 'GET' && req.url === '/worker.js') {
        res.setHeader('content-type', 'application/javascript');
        res.end(`self.addEventListener('install', () => self.skipWaiting());
          self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
          self.addEventListener('fetch', event => event.respondWith(new Response('<title>Seed worker poison</title>', {headers: {'content-type': 'text/html'}})));`);
      } else if (req.method === 'GET' && req.url === '/frame') {
        res.setHeader('content-type', 'text/html');
        res.end(`<script>fetch('https://www.amazon.com/checkout', {method: 'POST', mode: 'no-cors'}).catch(() => {})</script>`);
      } else if (req.method === 'POST' && req.url === addPath) {
        req.setEncoding('utf8');
        req.on('data', chunk => { recorded.body += chunk; });
        req.on('end', () => {
          res.writeHead(scenario === 'redirect-replay' ? 307 : 303, {
            location: scenario === 'redirect-replay' ? addPath : '/gp/cart/view.html?session=discarded',
          });
          res.end();
        });
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
          <div class="sc-list-item" data-asin="B012345678" ${scenario === 'live-shape' ? '' : 'data-condition="New"'} data-encoded-offering="${offer}" data-quantity="${quantity}">
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
    proxy = http.createServer((_req, res) => { res.writeHead(403); res.end(); });
    proxy.on('connect', (req, socket, head) => {
      if (req.url !== 'www.amazon.com:443' && req.url !== 'outside.test:443') {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const tunnel = net.connect(address.port, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) tunnel.write(head);
        socket.pipe(tunnel);
        tunnel.pipe(socket);
      });
      tunnels.add(tunnel);
      tunnel.on('error', () => socket.destroy());
      socket.on('error', () => tunnel.destroy());
      socket.on('close', () => { tunnel.destroy(); tunnels.delete(tunnel); });
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const proxyAddress = proxy.address();
    if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('Fixture proxy did not bind a TCP port');
    browser = await puppeteer.launch({
      executablePath,
      browser: browserEngine === 'firefox' ? 'firefox' : 'chrome',
      acceptInsecureCerts: true,
      headless: true,
      env: { ...process.env, MOZ_REMOTE_SETTINGS_DEVTOOLS: '1' },
      extraPrefsFirefox: browserEngine === 'firefox'
        ? buildFirefoxPrefs(`http://127.0.0.1:${proxyAddress.port}`, null, true) : undefined,
      args: browserEngine === 'chromium' ? [
        '--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
        '--no-proxy-server', '--disable-background-networking', '--disable-quic',
        `--host-resolver-rules=MAP www.amazon.com 127.0.0.1:${address.port}, MAP outside.test 127.0.0.1:${address.port}, MAP * ~NOTFOUND`,
      ] : [],
    });
    baseContexts = browser.browserContexts();
    session = {
      id: 'fixture', browser, launchPromise: null, activePages: 1, totalScrapes: 0,
      idleTimer: null, proxyUrl: null, userAgent: null, lastActivity: Date.now(),
      userDataDir: null, tainted: false, taintReason: null,
      browserEngine,
      amazonCartOnly: browserEngine === 'firefox',
    };
    const page = await browser.newPage();
    await page.setCookie({ name: 'user-session', value: 'not-for-cart', url: 'https://www.amazon.com/' });
    await page.close();
    controlBrowser = browserEngine === 'firefox' ? await puppeteer.launch({
      executablePath, browser: 'firefox', acceptInsecureCerts: true, headless: true,
      env: { ...process.env, MOZ_REMOTE_SETTINGS_DEVTOOLS: '1' },
      extraPrefsFirefox: buildFirefoxPrefs(`http://127.0.0.1:${proxyAddress.port}`, null),
    }) : browser;
  }, 60000);

  beforeEach(() => {
    scenario = 'valid';
    requests.length = 0;
    requestStarted = undefined;
  });

  afterAll(async () => {
    if (controlBrowser && controlBrowser !== browser) await controlBrowser.close();
    if (browser) await browser.close();
    for (const tunnel of tunnels) tunnel.destroy();
    if (proxy) await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 60000);

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
      'GET /dp/B012345678', `GET ${offersPath}`, `POST ${addPath}`, 'GET /gp/cart/view.html',
    ]);
    expect(requests.find(request => request.method === 'POST')?.body)
      .toBe(new URLSearchParams(offerFields).toString());
    expect(result?.browserEngine).toBe(browserEngine);
    expect(requests.every(request => !request.cookie?.includes('user-session'))).toBe(true);
    expect(browser.browserContexts()).toEqual(baseContexts);
  });

  it('blocks a cross-origin frame before it can send a checkout request', async () => {
    const control = await controlBrowser.newPage();
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
      'GET /dp/B012345678', `GET ${offersPath}`, `POST ${addPath}`, 'GET /gp/cart/view.html',
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
    'used', 'third-party', 'duplicate-form-quantity', 'override-action', 'override-encoding', 'target-blank', 'base-target',
  ] as const)(
    'does not submit an unsafe %s form',
    async value => {
      scenario = value;
      const result = await scrapeAmazonCart('https://www.amazon.com/dp/B012345678', session, {
        amazonCartMode: 'auto', timeout: 15000,
      });
      expect(result?.amazonCart).toEqual({ required: true, status: 'unavailable' });
      expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        'GET /dp/B012345678', `GET ${offersPath}`,
      ]);
      expect(browser.browserContexts()).toEqual(baseContexts);
    }
  );

  it('submits quantity 1 for the live offers-panel shape and accepts an unlabeled cart row', async () => {
    scenario = 'live-shape';
    const result = await scrapeAmazonCart(productUrl, session, { amazonCartMode: 'required', timeout: 15000 });
    expect(result?.amazonCart).toMatchObject({ required: true, status: 'verified', price: 249.99 });
    expect(requests.find(request => request.method === 'POST')?.body)
      .toBe(new URLSearchParams(offerFields).toString());
  });

  it('stops at a challenge in the offers panel without a cart POST', async () => {
    scenario = 'offers-challenge';
    const result = await scrapeAmazonCart(productUrl, session, { amazonCartMode: 'required', timeout: 15000 });
    expect(result?.challengeUnresolved).toBe(true);
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(0);
  });

  it('blocks a 307 redirect from replaying the cart POST', async () => {
    scenario = 'redirect-replay';
    await scrapeAmazonCart(productUrl, session, { amazonCartMode: 'required', timeout: 15000 });
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
  });

  it('keeps the cart protected while an ordinary browser has an active service worker', async () => {
    const control = await controlBrowser.newPage();
    try {
      // Keep a late control-page favicon out of the cart request ledger.
      control.on('request', request => request.isNavigationRequest() ||
        request.url() === 'https://www.amazon.com/worker.js' ? request.continue() : request.abort());
      await control.setRequestInterception(true);
      await control.goto('https://www.amazon.com/seed');
      await control.evaluate(async () => {
        await navigator.serviceWorker.register('/worker.js');
        await navigator.serviceWorker.ready;
      });
      await expect.poll(() => control.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
      await control.goto(productUrl);
      expect(await control.title()).toBe('Seed worker poison');
      requests.length = 0;
      const result = await scrapeAmazonCart(productUrl, session, { amazonCartMode: 'required', timeout: 15000 });
      expect(result?.amazonCart).toMatchObject({ status: 'verified', price: 249.99 });
      expect(requests.every(request => !request.cookie?.includes('user-session'))).toBe(true);
    } finally {
      await control.evaluate(async () => {
        for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
      });
      await control.close();
    }
  });

  if (browserEngine === 'firefox') {
    it('disables content scripts and service workers in the guarded browser itself', async () => {
      const page = await browser.newPage();
      try {
        await page.goto(productUrl, { waitUntil: 'domcontentloaded' });
        expect(await page.title()).toBe('Fixture product');
        expect(await page.evaluate(() => typeof navigator.serviceWorker)).toBe('undefined');
        expect(requests.filter(request => request.method === 'POST')).toHaveLength(0);
      } finally {
        await page.close();
      }
    });

    it('rejects an ordinary Firefox profile before creating a cart context', async () => {
      await expect(scrapeAmazonCart(productUrl, { ...session, amazonCartOnly: false }, {
        amazonCartMode: 'required',
      })).rejects.toThrow('script-disabled cart browser');
      expect(requests).toHaveLength(0);
      expect(browser.browserContexts()).toEqual(baseContexts);
    });

    it('sends only the validated body even when the browser submits different item fields', async () => {
      const context = await browser.createBrowserContext();
      try {
        const page = await context.newPage();
        const target = amazonTarget(productUrl)!;
        const permit = validateAmazonForm({
          action: `${target.origin}${addPath}`, method: 'POST',
          encoding: 'application/x-www-form-urlencoded', fields: offerFields,
          conditions: ['New'], seller: 'Amazon.com',
        }, target)!;
        const guard = { target, mainFrameId: 'main', permit, mutationSent: false };
        page.on('request', request => guardFirefoxAmazonRequest(request, page.mainFrame(), guard));
        await page.setRequestInterception(true);
        await page.goto(productUrl);
        const navigation = page.waitForNavigation({ timeout: 5000 }).catch(() => null);
        await page.evaluate(action => {
          const form = document.createElement('form');
          form.action = action;
          form.method = 'POST';
          const input = document.createElement('input');
          input.name = 'items[0.base][asin]';
          input.value = 'B099999999';
          form.append(input);
          document.body.append(form);
          form.requestSubmit();
        }, permit.action);
        await navigation;
        const posts = requests.filter(request => request.method === 'POST');
        expect(posts).toHaveLength(1);
        expect(posts[0].body).toBe(new URLSearchParams(offerFields).toString());
      } finally {
        await context.close();
      }
    });
  }

  it('rejects a cart row whose offer differs from the submitted form', async () => {
    scenario = 'different-offer';
    const result = await scrapeAmazonCart('https://www.amazon.com/dp/B012345678', session, {
      amazonCartMode: 'auto', timeout: 15000,
    });
    expect(result?.amazonCart).toEqual({ required: true, status: 'unavailable' });
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
    expect(browser.browserContexts()).toEqual(baseContexts);
  });

  it('rejects conflicting cart quantity indicators', async () => {
    scenario = 'conflicting-quantity';
    const result = await scrapeAmazonCart('https://www.amazon.com/dp/B012345678', session, {
      amazonCartMode: 'auto', timeout: 15000,
    });
    expect(result?.amazonCart).toEqual({ required: true, status: 'unavailable' });
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
    expect(browser.browserContexts()).toEqual(baseContexts);
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
    expect(browser.browserContexts()).toEqual(baseContexts);
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
    expect(browser.browserContexts()).toEqual(baseContexts);
  });
});
}
