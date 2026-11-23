import { describe, expect, it } from 'vitest';
import {
  allowAmazonRequest,
  amazonTarget,
  hasHiddenCartPrice,
  readCartPrice,
  validateAmazonForm,
  type AmazonForm,
  type AmazonGuard,
  type AmazonRequest,
  type CartRow,
} from '../../../scraper/src/services/AmazonCart';
import { amazonTarget as backendAmazonTarget, readAmazonCartMetadata } from '../../src/services/scraper/acquisition/amazon';
import { cleanUrl } from '../../src/utils/scraping/urlHelper';

const target = amazonTarget('https://www.amazon.com/dp/B012345678?tracking=discarded')!;
const form: AmazonForm = {
  action: 'https://www.amazon.com/gp/add-to-cart/html',
  method: 'post',
  encoding: 'application/x-www-form-urlencoded',
  fields: [
    ['ASIN.1', 'B012345678'],
    ['offeringID.1', 'offer-1'],
    ['quantity.1', '1'],
    ['condition', 'New'],
  ],
  conditions: ['New'],
};
const row: CartRow = {
  asin: 'B012345678',
  offerIds: ['offer-1'],
  quantities: ['1'],
  conditions: ['New'],
  prices: ['$249.99'],
};

function guard(): AmazonGuard {
  return { target, mainFrameId: 'main', permit: validateAmazonForm(form, target), mutationSent: false };
}

function request(overrides: Partial<AmazonRequest> = {}): AmazonRequest {
  return {
    url: 'https://www.amazon.com/gp/add-to-cart/html',
    method: 'POST',
    resourceType: 'Document',
    frameId: 'main',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    postData: new URLSearchParams(form.fields).toString(),
    ...overrides,
  };
}

describe('isolated Amazon cart validation', () => {
  it('accepts only safe product metadata without session-bearing URLs', () => {
    expect(readAmazonCartMetadata({ metadata: {
      name: 'Fixture product', imageUrl: 'https://m.media-amazon.com/images/I/fixture.jpg',
    } })).toEqual({ name: 'Fixture product', imageUrl: 'https://m.media-amazon.com/images/I/fixture.jpg' });
    for (const imageUrl of [
      'https://m.media-amazon.com/images/I/fixture.jpg?session=secret',
      'https://m.media-amazon.com.evil.example/images/I/fixture.jpg',
      'https://m.media-amazon.com/other/fixture.jpg',
    ]) {
      expect(readAmazonCartMetadata({ metadata: { name: 'name\u0000secret', imageUrl } }))
        .toEqual({ name: null, imageUrl: null });
    }
  });
  it('canonicalizes supported product URLs without retaining query parameters', () => {
    expect(target).toMatchObject({
      productUrl: 'https://www.amazon.com/dp/B012345678',
      asin: 'B012345678',
      currency: 'USD',
    });
    expect(amazonTarget('https://amazon.com.au/gp/product/b012345678?tag=ignored')).toMatchObject({
      productUrl: 'https://www.amazon.com.au/dp/B012345678',
      currency: 'AUD',
    });
  });

  it.each([
    'http://www.amazon.com/dp/B012345678',
    'https://amazon.com.evil.example/dp/B012345678',
    'https://user:pass@amazon.com/dp/B012345678',
    'https://amazon.com:8443/dp/B012345678',
    'https://amazon.com/gp/cart/view.html',
    'https://amazon.com/other/dp/B012345678',
    'https://amazon.com/dp/B012345678/other',
    'https://a.co/short',
    'https://amazon.com/dp/B012345678?m=SELLER',
    'https://amazon.com/dp/B012345678?seller=SELLER',
    'https://amazon.com/dp/B012345678?offerListingID=OFFER',
    'https://amazon.com/dp/B012345678?condition=used',
    'https://amazon.com/dp/B012345678?th=1',
    'https://amazon.com/dp/B012345678#variant=blue',
  ])('rejects unsupported or unsafe target %s', url => {
    expect(amazonTarget(url)).toBeNull();
    expect(backendAmazonTarget(url)).toBeNull();
  });

  it('retains seller and condition selections when cleaning an Amazon URL', () => {
    const cleaned = cleanUrl(
      'https://www.amazon.com/dp/B012345678?m=SELLER&seller=SELLER&condition=used&tag=tracking'
    );
    expect(cleaned).toContain('m=SELLER');
    expect(cleaned).toContain('seller=SELLER');
    expect(cleaned).toContain('condition=used');
    expect(cleaned).not.toContain('tag=');
    expect(backendAmazonTarget(cleaned)).toBeNull();
  });

  it('does not silently turn an unrecognized selection or fragment into a default-offer URL', () => {
    const unknownSelection = cleanUrl('https://www.amazon.com/dp/B012345678?offerListingID.1=OFFER');
    const fragment = cleanUrl('https://www.amazon.com/dp/B012345678#offer=OFFER');
    expect(new URL(unknownSelection).searchParams.get('offerListingID.1')).toBe('OFFER');
    expect(backendAmazonTarget(unknownSelection)).toBeNull();
    expect(backendAmazonTarget(fragment)).toBeNull();
    expect(backendAmazonTarget(cleanUrl(
      'https://www.amazon.com/dp/B012345678?tag=tracking&qid=123&utm_source=example'
    ))).not.toBeNull();
  });

  it.each(['a.co', 'amzn.to', 'smile.amazon.com'])(
    'preserves selection fragments on recognized Amazon host %s',
    host => {
      expect(new URL(cleanUrl(`https://${host}/product#offer=selected`)).hash).toBe('#offer=selected');
    }
  );

  it('detects an add-to-cart price notice without requiring exact whitespace', () => {
    expect(hasHiddenCartPrice('Add to Cart\n to see price')).toBe(true);
    expect(hasHiddenCartPrice('See price in your cart')).toBe(true);
    expect(hasHiddenCartPrice('Add to cart')).toBe(false);
  });

  it('allows only a single new, identified offer and quantity', () => {
    expect(validateAmazonForm(form, target)).toMatchObject({ offerId: 'offer-1' });
    const invalid: AmazonForm[] = [
      { ...form, method: 'get' },
      { ...form, encoding: 'multipart/form-data' },
      { ...form, action: `${form.action}?extra=1` },
      { ...form, action: 'https://www.amazon.com/checkout' },
      { ...form, conditions: [] },
      { ...form, conditions: ['Used'] },
      { ...form, conditions: ['New', 'Used'] },
      { ...form, fields: form.fields.filter(([name]) => name !== 'offeringID.1') },
      { ...form, fields: [...form.fields, ['ASIN.2', 'B012345678']] },
      { ...form, fields: [...form.fields, ['quantity.1', '2']] },
      { ...form, fields: [...form.fields, ['condition', 'Used']] },
      { ...form, fields: [...form.fields, ['buyNow', '1']] },
      { ...form, fields: [...form.fields, ['offeringID.1', 'other-offer']] },
      { ...form, fields: [...form.fields, ['ASIN_2', 'B012345679']] },
      { ...form, fields: [...form.fields, ['itemCount', '2']] },
      { ...form, fields: [...form.fields, ['exchangeID.1', 'exchange']] },
    ];
    for (const candidate of invalid) expect(validateAmazonForm(candidate, target)).toBeNull();
  });

  it('permits one exact form submission and blocks replay', () => {
    const state = guard();
    expect(allowAmazonRequest(request(), state)).toBe(true);
    expect(allowAmazonRequest(request(), state)).toBe(false);
    expect(allowAmazonRequest(request({
      url: 'https://www.amazon.com/gp/cart/view.html', method: 'GET', postData: undefined,
    }), state)).toBe(true);
  });

  it('blocks alternate endpoints, frames, requests and altered form bodies', () => {
    const altered: Partial<AmazonRequest>[] = [
      { method: 'GET' },
      { url: 'https://www.amazon.com/checkout' },
      { url: 'https://www.amazon.com/gp/add-to-cart/html?extra=1' },
      { url: 'https://evil.example/gp/add-to-cart/html' },
      { resourceType: 'Image' },
      { frameId: 'subframe' },
      { headers: { 'content-type': 'multipart/form-data' } },
      { postData: `${request().postData}&quantity.1=2` },
      { postData: '' },
    ];
    for (const change of altered) {
      const state = guard();
      expect(allowAmazonRequest(request(change), state)).toBe(false);
      expect(state.mutationSent).toBe(false);
    }
    expect(allowAmazonRequest(request({
      url: target.productUrl, method: 'GET', postData: undefined,
    }), guard())).toBe(true);
    expect(allowAmazonRequest(request({
      url: 'https://www.amazon.com/gp/cart/view.html', method: 'GET', postData: undefined,
    }), guard())).toBe(false);
  });

  it('requires the cart row to prove the same new offer, ASIN, quantity, and one unambiguous price', () => {
    expect(readCartPrice([row], target, 'offer-1')).toBe(249.99);
    const invalid: CartRow[][] = [
      [],
      [row, row],
      [{ ...row, asin: 'B012345679' }],
      [{ ...row, offerIds: [] }],
      [{ ...row, offerIds: ['different-offer'] }],
      [{ ...row, conditions: [] }],
      [{ ...row, conditions: ['Used'] }],
      [{ ...row, conditions: ['New', 'Used'] }],
      [{ ...row, quantities: [] }],
      [{ ...row, quantities: ['2'] }],
      [{ ...row, prices: ['$249.99', '$208.00'] }],
      [{ ...row, prices: ['$249.99', 'C$100.00'] }],
      [{ ...row, prices: ['AUD 249.99'] }],
      [{ ...row, prices: ['$0.00'] }],
      [{ ...row, prices: ['$100,000,000.00'] }],
    ];
    for (const candidate of invalid) expect(readCartPrice(candidate, target, 'offer-1')).toBeNull();
  });
});
