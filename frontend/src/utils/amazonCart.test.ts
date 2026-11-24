// Checks the UI cart-eligibility rule matches the backend's accepted Amazon URLs.
import { describe, expect, it } from 'vitest';
import { isAmazonCartUrl } from './amazonCart';

describe('isAmazonCartUrl', () => {
  it('accepts plain product URLs and tracking-only parameters', () => {
    expect(isAmazonCartUrl('https://www.amazon.com/dp/B0CJT5DJ16')).toBe(true);
    expect(isAmazonCartUrl('https://amazon.com.au/gp/product/B0CJT5DJ16/?tag=x&utm_source=y')).toBe(true);
  });

  it('rejects URLs the backend refuses, including offer or channel selections', () => {
    expect(isAmazonCartUrl('https://www.amazon.com/dp/B0CJT5DJ16?channelId=500')).toBe(false);
    expect(isAmazonCartUrl('https://www.amazon.com/dp/B0CJT5DJ16?th=1&psc=1')).toBe(false);
    expect(isAmazonCartUrl('https://www.amazon.com/dp/B0CJT5DJ16#offers')).toBe(false);
    expect(isAmazonCartUrl('https://www.amazon.co.uk/dp/B0CJT5DJ16')).toBe(false);
    expect(isAmazonCartUrl('http://www.amazon.com/dp/B0CJT5DJ16')).toBe(false);
    expect(isAmazonCartUrl(undefined)).toBe(false);
  });
});
