// Observe a single new Amazon offer in a disposable, anonymous browser context.
import type { AmazonCartResult, BrowserSession, ScrapeOptions, ScrapeResult } from '../types.js';
import { errorMessage } from '../types.js';
import { markSessionTainted } from '../core/SessionManager.js';
import { isProtocolError } from '../core/health.js';
import { buildChallengePattern, looksLikeChallenge } from '../utils/challenge.js';
import { log } from '../utils/logger.js';

export interface AmazonTarget {
  asin: string;
  marketplace: 'amazon.com' | 'amazon.com.au';
  origin: string;
  productUrl: string;
  offersUrl: string;
  currency: 'USD' | 'AUD';
}

export function amazonTarget(input: string): AmazonTarget | null {
  try {
    const url = new URL(input);
    const marketplace = url.hostname.replace(/^www\./, '');
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        (marketplace !== 'amazon.com' && marketplace !== 'amazon.com.au')) return null;
    if (url.hash || [...url.searchParams.keys()].some(key => !/^(?:tag|ref|ref_|tracking|utm_.+)$/i.test(key))) return null;
    const match = url.pathname.match(/^\/(?:dp|gp\/product)\/([a-z0-9]{10})\/?$/i);
    if (!match) return null;
    const asin = match[1].toUpperCase();
    const origin = `https://www.${marketplace}`;
    return {
      asin,
      marketplace,
      origin,
      productUrl: `${origin}/dp/${asin}`,
      offersUrl: `${origin}/gp/product/ajax/aodAjaxMain/?asin=${asin}&pc=dp&experienceId=aodAjaxMain`,
      currency: marketplace === 'amazon.com' ? 'USD' : 'AUD',
    };
  } catch {
    return null;
  }
}

export function hasHiddenCartPrice(text: string): boolean {
  return /\b(?:see|view|show|display|find)\s+(?:the\s+)?price\s+(?:in|at)\s+(?:your\s+|the\s+)?cart\b|\badd\s+to\s+(?:your\s+|the\s+)?cart\s+to\s+(?:see|view|show)\s+(?:the\s+)?(?:price|product details)\b/i.test(text.replace(/\s+/g, ' '));
}

type Field = [string, string];

export interface AmazonForm {
  action: string;
  method: string;
  encoding: string;
  fields: Field[];
  conditions: string[];
  seller?: string | null;
}

export interface CartRow {
  asin: string;
  offerIds: string[];
  quantities: string[];
  conditions: string[];
  prices: string[];
}

export interface AmazonPermit {
  action: string;
  offerId: string;
  fields: Field[];
}

const ADD_PATHS = new Set(['/gp/add-to-cart/html', '/gp/aws/cart/add.html', '/gp/cart/add-to-cart.html']);
const AMAZON_OFFERS_ADD_PATH = /^\/cart\/add-to-cart\/ref=aod_dpdsk_new_\d+$/;
const AUXILIARY_FIELDS = new Set([
  'condition', 'itemcondition', 'condition.1', 'itemcondition.1',
  'merchantid', 'merchantid.1', 'session-id', 'anti-csrftoken-a2z',
  'csrf-token', 'submit.add-to-cart', 'submit.addtocart',
]);
const AMAZON_OFFERS_QUANTITY = 'items[0.base][quantity]';
const AMAZON_OFFERS_FIELDS = new Set([
  'anti-csrftoken-a2z',
  'items[0.base][asin]',
  'items[0.base][offerlistingid]',
  'items[0.base][quantity]',
  'items[0.base][additionalparameters][listpurchaseattribution][listattributionid]',
  'items[0.base][additionalparameters][listpurchaseattribution][itemattributionid]',
  'clientname',
]);

function isAmazonOffersUrl(url: URL, target: AmazonTarget): boolean {
  const params = [...url.searchParams.entries()];
  return url.origin === target.origin && !url.username && !url.password && !url.hash &&
    url.pathname === '/gp/product/ajax/aodAjaxMain/' && params.length === 3 &&
    url.searchParams.getAll('asin').length === 1 && url.searchParams.get('asin') === target.asin &&
    url.searchParams.getAll('pc').length === 1 && url.searchParams.get('pc') === 'dp' &&
    url.searchParams.getAll('experienceId').length === 1 &&
    url.searchParams.get('experienceId') === 'aodAjaxMain';
}

function isAmazonCheckpointUrl(url: URL, target: AmazonTarget): boolean {
  return url.origin === target.origin && !url.username && !url.password &&
    /^\/(?:errors_page\/validateCaptcha|checkpoint\/continue)$/.test(url.pathname);
}

function isNewCondition(value: string): boolean {
  return /^(?:condition\s*:\s*)?new$/i.test(value.trim());
}

export function validateAmazonForm(form: AmazonForm | null, target: AmazonTarget): AmazonPermit | null {
  if (!form || form.method.toUpperCase() !== 'POST' ||
      form.encoding.toLowerCase() !== 'application/x-www-form-urlencoded' ||
      !form.conditions.length || !form.conditions.every(isNewCondition)) return null;
  let action: URL;
  try {
    action = new URL(form.action);
  } catch {
    return null;
  }
  if (action.origin !== target.origin || action.username || action.password ||
      action.search || action.hash) return null;
  const amazonOffersForm = AMAZON_OFFERS_ADD_PATH.test(action.pathname);
  const expectedSeller = target.marketplace === 'amazon.com' ? 'Amazon.com' : 'Amazon.com.au';
  if (form.seller?.trim() !== expectedSeller ||
      (!amazonOffersForm && !ADD_PATHS.has(action.pathname))) return null;
  if (form.fields.length === 0 || form.fields.length > 100) return null;
  if (amazonOffersForm) {
    const names = form.fields.map(([name]) => name.toLowerCase());
    if (new Set(names).size !== names.length ||
        names.some(name => !AMAZON_OFFERS_FIELDS.has(name))) return null;
  }

  const asins: string[] = [];
  const offers: string[] = [];
  const quantities: string[] = [];
  const fields: Field[] = [];
  for (const [name, original] of form.fields) {
    // With scripts disabled, Amazon leaves the offers-panel quantity blank;
    // its own click handler would submit 1. Submission fills the same value.
    const value = amazonOffersForm && name.toLowerCase() === AMAZON_OFFERS_QUANTITY && original === ''
      ? '1' : original;
    fields.push([name, value]);
    if (name.length > 200 || value.length > 8192 ||
        /checkout|buy.?now|order|delete|remove|wishlist/i.test(name)) return null;
    if (/^(?:item)?condition(?:\.\d+)?$/i.test(name) && !isNewCondition(value)) return null;
    const offersItemField = amazonOffersForm
      ? name.match(/^items\[0\.base\]\[(asin|offerlistingid|quantity)\]$/i)
      : null;
    const itemField = offersItemField ||
      name.match(/^(asin|offeringid|offerlistingid|quantity|sellerid)(?:\.(\d+))?$/i);
    if (!itemField) {
      if (amazonOffersForm ? !AMAZON_OFFERS_FIELDS.has(name.toLowerCase()) :
          !AUXILIARY_FIELDS.has(name.toLowerCase())) return null;
      continue;
    }
    if (!amazonOffersForm && itemField[2] && itemField[2] !== '1') return null;
    switch (itemField[1].toLowerCase()) {
      case 'asin': asins.push(value.toUpperCase()); break;
      case 'offeringid':
      case 'offerlistingid': offers.push(value); break;
      case 'quantity': quantities.push(value); break;
    }
  }
  if (!asins.length || asins.some(asin => asin !== target.asin) ||
      !offers.length || offers.some(offer => !offer || offer !== offers[0]) ||
      !quantities.length || quantities.some(quantity => quantity !== '1')) return null;
  return { action: action.href, offerId: offers[0], fields };
}

export interface AmazonRequest {
  url: string;
  method: string;
  resourceType: string;
  frameId?: string;
  headers?: Record<string, unknown>;
  postData?: string;
}

export interface AmazonGuard {
  target: AmazonTarget;
  mainFrameId: string;
  permit: AmazonPermit | null;
  mutationSent: boolean;
}

function equalFields(actual: URLSearchParams, expected: Field[]): boolean {
  const sortFields = (fields: Field[]) =>
    fields.map(([key, value]) => JSON.stringify([key, value])).sort();
  const left = sortFields([...actual.entries()]);
  const right = sortFields(expected);
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function allowAmazonRequest(request: AmazonRequest, guard: AmazonGuard): boolean {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (url.origin !== guard.target.origin || url.username || url.password ||
      request.resourceType !== 'Document' || request.frameId !== guard.mainFrameId) return false;
  if (request.method === 'GET') {
    if (isAmazonCheckpointUrl(url, guard.target)) return true;
    if (isAmazonOffersUrl(url, guard.target) && !guard.mutationSent) return true;
    if (url.search || url.hash) return false;
    const productPath = new RegExp(`^/(?:dp|gp/product)/${guard.target.asin}/?$`, 'i');
    return productPath.test(url.pathname) ||
      (guard.mutationSent && !!guard.permit && url.href === guard.permit.action) ||
      (guard.mutationSent && url.pathname === '/gp/cart/view.html');
  }
  if (request.method !== 'POST' || guard.mutationSent || !guard.permit ||
      url.href !== guard.permit.action ||
      !(ADD_PATHS.has(url.pathname) || AMAZON_OFFERS_ADD_PATH.test(url.pathname)) ||
      !request.postData || request.postData.length > 65536) return false;
  const contentType = Object.entries(request.headers || {})
    .find(([name]) => name.toLowerCase() === 'content-type')?.[1];
  if (typeof contentType !== 'string' ||
      !/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(contentType)) return false;
  if (!equalFields(new URLSearchParams(request.postData), guard.permit.fields)) return false;
  guard.mutationSent = true;
  return true;
}

export interface FirefoxAmazonRequest {
  url(): string;
  method(): string;
  headers(): Record<string, string>;
  frame(): object | null;
  isNavigationRequest(): boolean;
  continue(overrides?: { postData?: string; headers?: Record<string, string> }): Promise<void>;
  abort(): Promise<void>;
}

export async function guardFirefoxAmazonRequest(
  request: FirefoxAmazonRequest,
  mainFrame: object,
  guard: AmazonGuard,
): Promise<void> {
  // Firefox cannot expose CDP resource types or POST bytes. For its one allowed
  // navigation POST, replace the body with our already-validated form instead.
  const body = request.method() === 'POST' && guard.permit
    ? new URLSearchParams(guard.permit.fields).toString() : undefined;
  const headers = request.headers();
  const permitted = allowAmazonRequest({
    url: request.url(),
    method: request.method(),
    resourceType: request.isNavigationRequest() ? 'Document' : 'Other',
    frameId: request.frame() === mainFrame ? guard.mainFrameId : undefined,
    headers,
    postData: body,
  }, guard);
  if (!permitted) {
    await request.abort();
    return;
  }
  if (body !== undefined) {
    const rewrittenHeaders = Object.fromEntries(Object.entries(headers)
      .filter(([name]) => !/^(?:content-length|transfer-encoding)$/i.test(name)));
    await request.continue({ postData: body, headers: rewrittenHeaders });
  } else {
    await request.continue();
  }
}

export function describeCartRows(rows: CartRow[], target: AmazonTarget, offerId: string): string {
  const clean = (value: string) => value.replace(/\s+/g, ' ').replace(/[^\w .:$,/-]/g, '').trim().slice(0, 40);
  return rows.slice(0, 3).map(row => `[asin ${row.asin.toUpperCase() === target.asin ? 'target' : 'other'} | ` +
    `qty ${row.quantities.map(clean).join(',') || '-'} | ` +
    `offers ${row.offerIds.map(value => value === offerId ? 'match' : `other(${value.length})`).join(',') || '-'} | ` +
    `cond ${row.conditions.map(clean).join(',') || '-'} | price ${row.prices.map(clean).join(',') || '-'}]`).join(' ') || 'none';
}

export function readCartPrice(rows: CartRow[], target: AmazonTarget, offerId: string): number | null {
  if (rows.length !== 1) return null;
  const row = rows[0];
  if (row.asin.toUpperCase() !== target.asin || !row.quantities.length ||
      row.quantities.some(quantity => quantity !== '1') ||
      !row.offerIds.length || row.offerIds.some(value => value !== offerId) ||
      // The offer ID was validated as new and Amazon-sold; Amazon's cart may omit
      // a condition label, but any label it does show must still say new.
      !row.conditions.every(isNewCondition)) return null;
  const prefix = target.currency === 'USD' ? '(?:US\\$|USD\\s*|\\$)' : '(?:AU\\$|AUD\\s*|\\$)';
  const pattern = new RegExp(`^${prefix}\\s*(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d{2}))?$`, 'i');
  const values = row.prices.map(text => {
    const match = text.replace(/\s+/g, ' ').trim().match(pattern);
    return match ? Number(`${match[1].replace(/,/g, '')}.${match[2] || '00'}`) : null;
  });
  const first = values[0];
  if (first === null || first === undefined || !Number.isFinite(first) || first <= 0 ||
      first > 99999999.99 || values.some(value => value !== first)) return null;
  return first;
}

function readProductNotice(): string {
  return Array.from(document.querySelectorAll(
    '#desktop_buybox, #buybox, #corePrice_feature_div, #apex_desktop, #newBuyBoxPrice'
  )).map(element => `${element.textContent || ''} ${element.getAttribute('aria-label') || ''}`).join(' ') +
    ` ${document.querySelector('#add-to-cart-button')?.getAttribute('aria-label') || ''}`;
}

function readProductMetadata(): { name: string | null; imageUrl: string | null } {
  const name = document.querySelector('#productTitle')?.textContent?.replace(/\s+/g, ' ').trim() || null;
  const imageUrl = document.querySelector<HTMLImageElement>('#landingImage')?.src || null;
  return { name, imageUrl };
}

export function isAmazonCheckpointPage(html: string, url: string): boolean {
  return /\/(?:errors_page\/validateCaptcha|checkpoint\/continue)(?:[/?#]|$)/i.test(url) ||
    /<form\b[^>]*(?:action|id)\s*=\s*["'][^"']*(?:validateCaptcha|captcha)/i.test(html);
}

// Field values (offer IDs, session tokens) are omitted; only shape is logged.
export function describeOffers(offers: AmazonForm[], target: AmazonTarget): string {
  const clean = (value: string | null | undefined, max = 60) =>
    (value || '-').replace(/[^\w .:/=[\]-]/g, '').slice(0, max);
  return offers.slice(0, 3).map(offer => {
    let action = '-';
    try {
      const url = new URL(offer.action);
      action = `${url.origin === target.origin ? 'same-origin' : 'other-origin'}${clean(url.pathname)}` +
        `${url.search ? ' +query' : ''}${url.hash ? ' +hash' : ''}`;
    } catch { /* invalid action */ }
    const fields = offer.fields.map(([name, value]) => {
      const key = name.toLowerCase();
      const shape = key.endsWith('[asin]') ? (value.toUpperCase() === target.asin ? '=target' : '=other')
        : key.endsWith('[quantity]') ? `=${clean(value, 4)}`
          : `(${value.length})`;
      return `${clean(name, 120)}${shape}`;
    });
    return `[${clean(offer.conditions[0])} | ${clean(offer.seller)} | ${offer.method} ${clean(offer.encoding)} ` +
      `${action} | ${fields.join(',').slice(0, 700)}]`;
  }).join(' ') || 'none';
}

function readAmazonOffers(): AmazonForm[] {
  return Array.from(document.querySelectorAll<HTMLElement>('#aod-pinned-offer, #aod-offer'))
    .filter(offer => !offer.parentElement?.closest('#aod-pinned-offer, #aod-offer'))
    .flatMap(offer => {
      const form = offer.querySelector<HTMLFormElement>('form');
      if (!form) return [];
      const fields: Field[] = [];
      for (const [name, value] of new FormData(form).entries()) {
        if (typeof value !== 'string') return [];
        fields.push([name, value]);
      }
      const condition = offer.querySelector('#aod-offer-heading')?.textContent?.replace(/\s+/g, ' ').trim() || '';
      const seller = offer.querySelector(
        '#aod-offer-soldBy .a-color-base, #aod-offer-soldBy a, .aod-offer-soldBy .a-color-base, .aod-offer-soldBy a'
      )?.textContent?.replace(/\s+/g, ' ').trim() || null;
      return [{
        action: form.action,
        method: form.method,
        encoding: form.enctype,
        fields,
        conditions: condition ? [condition] : [],
        seller,
      }];
    });
}

function safeProductMetadata(metadata: { name: string | null; imageUrl: string | null }) {
  const name = metadata.name && !/[\u0000-\u001f\u007f]/.test(metadata.name)
    ? metadata.name.slice(0, 255) : null;
  let imageUrl: string | null = null;
  if (metadata.imageUrl) {
    try {
      const image = new URL(metadata.imageUrl);
      if (image.protocol === 'https:' && image.hostname === 'm.media-amazon.com' &&
          !image.username && !image.password && !image.port &&
          /^\/images\/I\/[a-zA-Z0-9._+-]+$/.test(image.pathname)) {
        imageUrl = `${image.origin}${image.pathname}`;
      }
    } catch {
      // Invalid image URLs are not returned.
    }
  }
  return { name, imageUrl };
}

function submitAmazonOfferForm(action: string): void {
  // Match readAmazonOffers: the panel can repeat forms outside top-level offers.
  const forms = Array.from(document.querySelectorAll<HTMLElement>('#aod-pinned-offer, #aod-offer'))
    .filter(offer => !offer.parentElement?.closest('#aod-pinned-offer, #aod-offer'))
    .flatMap(offer => {
      const form = offer.querySelector<HTMLFormElement>('form');
      return form && form.action === action ? [form] : [];
    });
  if (forms.length !== 1) throw new Error(`Amazon offer form is no longer unique (${forms.length})`);
  // Request guards cover only this page; a form targeting another window would escape them.
  const target = forms[0].getAttribute('target') ?? document.querySelector('base[target]')?.getAttribute('target') ?? '';
  if (target.trim() && target.trim().toLowerCase() !== '_self') throw new Error('Amazon offer form targets another window');
  const quantities = Array.from(forms[0].elements).filter((element): element is HTMLInputElement =>
    element instanceof HTMLInputElement && element.name.toLowerCase() === 'items[0.base][quantity]');
  if (quantities.length === 1 && quantities[0].value === '') quantities[0].value = '1';
  forms[0].requestSubmit();
}

function readCartRows(): CartRow[] {
  return Array.from(document.querySelectorAll<HTMLElement>(
    '#sc-active-cart [data-asin], #activeCartViewForm [data-asin]'
  )).filter(row => !row.parentElement?.closest('[data-asin]')).map(row => {
    const quantities = Array.from(row.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      'select[name^="quantity"], input[name^="quantity"], input[name="items[0.base][quantity]"]'
    )).map(element => element.value);
    const storedQuantity = row.getAttribute('data-quantity');
    if (storedQuantity !== null) quantities.push(storedQuantity);
    const displayedQuantity = row.querySelector(
      '.sc-action-quantity [data-a-selector="value"], .sc-action-quantity .a-dropdown-prompt'
    )?.textContent?.trim();
    if (displayedQuantity) quantities.push(displayedQuantity);
    const offerIds = [
      row.getAttribute('data-offering-id'),
      row.getAttribute('data-offeringid'),
      row.getAttribute('data-offer-listing-id'),
      row.getAttribute('data-offerlistingid'),
      row.getAttribute('data-encoded-offering'),
      ...Array.from(row.querySelectorAll<HTMLInputElement>(
        'input[name^="offeringID"], input[name^="offerListingID"], input[name="items[0.base][offerListingId]"]'
      )).map(element => element.value),
    ].filter((value): value is string => !!value);
    const conditions: string[] = [];
    const rowCondition = row.getAttribute('data-condition');
    if (rowCondition !== null) conditions.push(rowCondition);
    for (const element of row.querySelectorAll('[data-condition], .sc-product-condition')) {
      const attribute = element.getAttribute('data-condition');
      const text = element.textContent?.trim();
      if (attribute !== null) conditions.push(attribute);
      if (text) conditions.push(text);
    }
    const struckPrice = '.a-text-strike, .a-text-price, del, s';
    const prices = Array.from(row.querySelectorAll<HTMLElement>(
      '.sc-item-price, .sc-product-price, .apex-price-to-pay-value'
    )).filter(element => !element.closest(struckPrice)).flatMap(element => {
      const current = Array.from(element.querySelectorAll<HTMLElement>('.a-offscreen'))
        .filter(price => !price.closest(struckPrice));
      if (current.length) return current.map(price => price.textContent?.trim() || '');
      if (element.querySelector(struckPrice)) return [''];
      return [element.textContent?.trim() || ''];
    });
    return { asin: row.dataset.asin || '', offerIds, quantities, conditions, prices };
  });
}

export async function scrapeAmazonCart(
  url: string,
  session: BrowserSession,
  options: ScrapeOptions,
  signal?: AbortSignal,
): Promise<ScrapeResult | null> {
  const target = amazonTarget(url);
  if (!target || !session.browser) throw new Error('Unsupported Amazon product URL');
  if (session.browserEngine === 'firefox' && session.amazonCartOnly !== true) {
    throw new Error('Firefox cart checks require a script-disabled cart browser');
  }
  if (signal?.aborted) return null;
  const context = await session.browser.createBrowserContext();
  let closing: Promise<void> | undefined;
  const closeContext = () => closing ??= context.close();
  const onAbort = () => {
    void closeContext().catch(() => log('Failed to close aborted Amazon context', 'WARN'));
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    if (signal?.aborted) return null;
    const page = await context.newPage();
    if (session.browserEngine !== 'firefox') await page.setJavaScriptEnabled(false);
    await page.setCacheEnabled(false);
    const guard: AmazonGuard = {
      target,
      mainFrameId: 'main',
      permit: null,
      mutationSent: false,
    };
    let guardFailed = false;
    const prepareFirefoxPage = async (candidate: typeof page) => {
      await candidate.setCacheEnabled(false);
      const mainFrame = candidate.mainFrame();
      candidate.on('request', request => guardFirefoxAmazonRequest(request, mainFrame, guard)
        .catch(() => {
          guardFailed = true;
          log('Firefox Amazon request guard failed', 'WARN', { requestId: options.requestId, productId: options.productId });
          void closeContext().catch(() => log('Failed to close guarded Amazon context', 'WARN'));
        }));
      await candidate.setRequestInterception(true);
    };
    if (session.browserEngine === 'firefox') {
      // Firefox cart profiles disable scripts and workers at launch: ESR lacks
      // per-page scripting controls and CDP service-worker bypass.
      await prepareFirefoxPage(page);
    } else {
      await page.setBypassServiceWorker(true);
      if (options.userAgent) await page.setUserAgent(options.userAgent);
      const client = await page.target().createCDPSession();
      const frameTree = await client.send('Page.getFrameTree');
      guard.mainFrameId = frameTree.frameTree.frame.id;
      client.on('Fetch.requestPaused', event => {
        const permitted = allowAmazonRequest({
          url: event.request.url,
          method: event.request.method,
          resourceType: event.resourceType,
          frameId: event.frameId,
          headers: event.request.headers,
          postData: event.request.postData,
        }, guard);
        void client.send(permitted ? 'Fetch.continueRequest' : 'Fetch.failRequest',
          permitted ? { requestId: event.requestId } : { requestId: event.requestId, errorReason: 'BlockedByClient' }
        ).catch(() => { guardFailed = true; });
      });
      await client.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    }
    const deadline = Date.now() + Math.max(1000, options.timeout || 60000);
    const remaining = () => Math.max(1, deadline - Date.now());
    const productResponse = await page.goto(target.productUrl, { waitUntil: 'domcontentloaded', timeout: remaining() });
    if (guardFailed) throw new Error('Amazon request guard failed');
    if (signal?.aborted) return null;
    const html = await page.content();
    const title = await page.title();
    const challenge = isAmazonCheckpointPage(html, page.url()) ||
      looksLikeChallenge(title, html, buildChallengePattern(options.challengePatterns));
    const base: ScrapeResult = {
      html: '',
      screenshotBase64: null,
      challengeDetected: challenge,
      challengeUnresolved: challenge,
      browserEngine: session.browserEngine,
    };
    const unavailable: AmazonCartResult = { required: true, status: 'unavailable' };
    const stop = (reason: string, result: ScrapeResult = base): ScrapeResult => {
      log(`Amazon cart check stopped | Reason: ${reason} | Engine: ${session.browserEngine}`, 'WARN',
        { requestId: options.requestId, productId: options.productId });
      return { ...result, amazonCart: unavailable };
    };
    if (challenge) return stop('product challenge');
    if (productResponse?.status() !== 200) return stop(`product status ${productResponse?.status() ?? 'none'}`);

    let notice: string;
    try {
      notice = await page.evaluate(readProductNotice);
    } catch (error) {
      if (signal?.aborted) return null;
      if (isProtocolError(error)) markSessionTainted(session, 'Amazon product notice browser protocol error');
      log('Amazon product notice could not be inspected', 'WARN', { requestId: options.requestId, productId: options.productId });
      return { ...base, amazonCart: unavailable };
    }
    const required = options.amazonCartMode === 'required' || hasHiddenCartPrice(notice);
    if (!required) return { ...base, amazonCart: { required: false } };
    let stage = 'offers';
    try {
      const metadata = safeProductMetadata(await page.evaluate(readProductMetadata));
      const offersResponse = await page.goto(target.offersUrl, {
        waitUntil: 'domcontentloaded',
        timeout: remaining(),
      });
      if (signal?.aborted) return null;
      if (guardFailed) throw new Error('Amazon request guard failed');
      const offersHtml = await page.content();
      const offersTitle = await page.title();
      const offersChallenge = isAmazonCheckpointPage(offersHtml, page.url()) ||
        looksLikeChallenge(offersTitle, offersHtml, buildChallengePattern(options.challengePatterns));
      if (offersChallenge) {
        return stop('offers challenge', { ...base, challengeDetected: true, challengeUnresolved: true });
      }
      if (offersResponse?.status() !== 200) return stop(`offers status ${offersResponse?.status() ?? 'none'}`);
      const offers = await page.evaluate(readAmazonOffers);
      const permits = offers
        .map(form => validateAmazonForm(form, target))
        .filter((permit): permit is AmazonPermit => permit !== null);
      if (permits.length !== 1) {
        return stop(`${permits.length} eligible Amazon new offers of ${offers.length}: ${describeOffers(offers, target)}`);
      }
      guard.permit = permits[0];
      if (!guard.permit || remaining() <= 1) return stop('timeout before submission');
      stage = 'submission';
      const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: Math.min(8000, remaining()) })
        .catch(() => null);
      await page.evaluate(submitAmazonOfferForm, guard.permit.action);
      await navigation;
      if (signal?.aborted) return null;
      if (!guard.mutationSent) return stop('cart add request not sent');
      if (guardFailed || remaining() <= 1) return stop('guard failure or timeout after submission');
      stage = 'cart';
      let cartPage = page;
      if (session.browserEngine === 'firefox') {
        // An aborted redirect can leave BiDi navigation waiting on the old page.
        // Read the clean cart URL in a guarded page in the same guest context.
        await page.close();
        cartPage = await context.newPage();
        await prepareFirefoxPage(cartPage);
      }
      await cartPage.goto(`${target.origin}/gp/cart/view.html`, { waitUntil: 'domcontentloaded', timeout: remaining() });
      if (guardFailed) return stop('guard failure on cart page');
      const rows = await cartPage.evaluate(readCartRows);
      const price = readCartPrice(rows, target, guard.permit.offerId);
      if (price === null) return stop(`cart price not verified: ${describeCartRows(rows, target, guard.permit.offerId)}`);
      return { ...base, amazonCart: {
        required: true, status: 'verified', asin: target.asin, marketplace: target.marketplace,
        condition: 'new', price, currency: target.currency, metadata,
      } };
    } catch (error) {
      if (signal?.aborted) return null;
      if (isProtocolError(error)) markSessionTainted(session, 'Amazon cart browser protocol error');
      log(`Amazon cart price could not be verified | Stage: ${stage} | Engine: ${session.browserEngine} | ` +
        `Cart add sent: ${guard.mutationSent} | Error: ${errorMessage(error).replace(/\s+/g, ' ').slice(0, 200)}`, 'WARN', { requestId: options.requestId, productId: options.productId });
      return { ...base, amazonCart: unavailable };
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await closeContext();
  }
}
