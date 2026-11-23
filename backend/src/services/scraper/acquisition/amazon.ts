// Validate the remote scraper's Amazon cart evidence before it enters the pipeline.
export { isAmazonMarketplaceUrl } from '../../../utils/scraping/urlHelper';

export const AMAZON_CART_METHOD = 'amazon-cart';
export const AMAZON_CART_BASIS = 'amazon-cart-new';

export interface AmazonTarget {
  asin: string;
  marketplace: 'amazon.com' | 'amazon.com.au';
  productUrl: string;
  currency: 'USD' | 'AUD';
}

export interface AmazonCartObservation {
  asin: string;
  marketplace: 'amazon.com' | 'amazon.com.au';
  condition: 'new';
  price: number;
  currency: 'USD' | 'AUD';
}

export function readAmazonCartMetadata(value: unknown): { name: string | null; imageUrl: string | null } {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const metadata = result.metadata && typeof result.metadata === 'object'
    ? result.metadata as Record<string, unknown> : {};
  const name = typeof metadata.name === 'string' && metadata.name.length <= 255 &&
    !/[\u0000-\u001f\u007f]/.test(metadata.name) ? metadata.name.trim() || null : null;
  let imageUrl: string | null = null;
  if (typeof metadata.imageUrl === 'string') {
    try {
      const image = new URL(metadata.imageUrl);
      if (image.protocol === 'https:' && image.hostname === 'm.media-amazon.com' &&
          !image.username && !image.password && !image.port && !image.search && !image.hash &&
          /^\/images\/I\/[a-zA-Z0-9._+-]+$/.test(image.pathname)) {
        imageUrl = image.href;
      }
    } catch {
      // Invalid image URLs are not accepted.
    }
  }
  return { name, imageUrl };
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
    return {
      asin,
      marketplace,
      productUrl: `https://www.${marketplace}/dp/${asin}`,
      currency: marketplace === 'amazon.com' ? 'USD' : 'AUD',
    };
  } catch {
    return null;
  }
}

export function readAmazonCartObservation(value: unknown, target: AmazonTarget): AmazonCartObservation | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as Record<string, unknown>;
  if (result.required !== true || result.status !== 'verified' || result.asin !== target.asin ||
      result.marketplace !== target.marketplace || result.condition !== 'new' ||
      result.currency !== target.currency || typeof result.price !== 'number' ||
      !Number.isFinite(result.price) || result.price <= 0 || result.price > 99999999.99 ||
      Math.round(result.price * 100) / 100 !== result.price) return null;
  return {
    asin: target.asin,
    marketplace: target.marketplace,
    condition: 'new',
    price: result.price,
    currency: target.currency,
  };
}

