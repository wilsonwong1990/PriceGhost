// Mirrors amazonTarget() in backend/src/services/scraper/acquisition/amazon.ts so
// the UI only offers cart tracking for URLs the backend will accept.
const ALLOWED_QUERY_KEY = /^(?:tag|ref|ref_|tracking|utm_.+)$/i;
const PRODUCT_PATH = /^\/(?:dp|gp\/product)\/[a-z0-9]{10}\/?$/i;

export function isAmazonCartUrl(input: string | null | undefined): boolean {
  if (!input) return false;
  try {
    const url = new URL(input);
    const marketplace = url.hostname.replace(/^www\./, '');
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        (marketplace !== 'amazon.com' && marketplace !== 'amazon.com.au')) return false;
    if (url.hash || [...url.searchParams.keys()].some(key => !ALLOWED_QUERY_KEY.test(key))) return false;
    return PRODUCT_PATH.test(url.pathname);
  } catch {
    return false;
  }
}
