import { load, type CheerioAPI } from 'cheerio';

const AMAZON_HOST = /^(?:[a-z0-9-]+\.)*amazon\.(?:com|com\.au|co\.uk|ca|de|fr|it|es|nl|se|pl|com\.be|ie|com\.mx|com\.br|co\.jp|in|sg|ae|sa|eg|com\.tr|co\.za|cn)$/i;
const ASIN = /^[A-Z0-9]{10}$/;

export function isAmazonUrl(url: string): boolean {
  try {
    return AMAZON_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export type AmazonScope =
  | { kind: 'other' }
  | { kind: 'ambiguous'; detail: string }
  | { kind: 'scoped'; html: string; stockHtml: string };

/**
 * Restrict Amazon extraction to the requested, selected listing. Page-wide
 * selectors otherwise see prices and availability for other products and sizes.
 */
export function scopeAmazonPage(url: string, $: CheerioAPI): AmazonScope {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'other' };
  }
  if (!AMAZON_HOST.test(parsed.hostname)) return { kind: 'other' };

  const requested = parsed.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([a-z0-9]{10})(?:\/|$)/i)?.[1]?.toUpperCase();
  const asinInputs = $('#ASIN');
  const displayed = String(asinInputs.first().attr('value') || '').toUpperCase();
  if (!requested || asinInputs.length !== 1 || !ASIN.test(displayed) || requested !== displayed) {
    return { kind: 'ambiguous', detail: 'The requested Amazon listing does not match the selected product.' };
  }

  // Inline twister controls identify the ASIN of the selected size and colour.
  // A missing or conflicting selection must not silently become a default.
  const rows = $('[id^="inline-twister-row-"]');
  for (const row of rows.toArray()) {
    const selected = $(row).find('li[data-asin]').filter((_, el) =>
      $(el).find('[aria-checked="true"]').length > 0
    );
    if (selected.length !== 1 || String(selected.first().attr('data-asin') || '').toUpperCase() !== requested) {
      return { kind: 'ambiguous', detail: 'An Amazon product option is not selected for the requested listing.' };
    }
  }
  if ($('#twister, #twister_feature_div, [id^="variation_"]').length > 0) {
    return { kind: 'ambiguous', detail: 'The selected Amazon product options could not be verified.' };
  }

  const priceFeature = $('#corePrice_feature_div');
  const availabilityFeature = $('#availabilityInsideBuyBox_feature_div');
  if (priceFeature.length > 1 || availabilityFeature.length > 1) {
    return { kind: 'ambiguous', detail: 'The Amazon listing contains conflicting offer sections.' };
  }
  const priceAsin = String(priceFeature.attr('data-csa-c-asin') || '').toUpperCase();
  const prices = [...new Set(priceFeature.find('.apex-pricetopay-value .a-offscreen')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean))];
  const conflicts = (element: ReturnType<CheerioAPI>) => element
    .find('[data-asin], [data-csa-c-asin]')
    .add(element)
    .add(element.parents('[data-asin], [data-csa-c-asin]'))
    .toArray().some(el => {
      return ['data-asin', 'data-csa-c-asin'].some(attribute => {
        const asin = String($(el).attr(attribute) || '').toUpperCase();
        return ASIN.test(asin) && asin !== requested;
      });
    });
  if ((priceAsin && priceAsin !== requested) || prices.length > 1 || conflicts(priceFeature)) {
    return { kind: 'ambiguous', detail: 'The displayed Amazon price could not be tied to the selected listing.' };
  }

  const stockAsin = String(availabilityFeature.attr('data-csa-c-asin') || '').toUpperCase();
  const stockText = stockAsin === requested && !conflicts(availabilityFeature)
    ? availabilityFeature.find('#availability').first().text().trim() : '';
  if ((priceAsin !== requested || prices.length === 0) && !stockText) {
    return { kind: 'ambiguous', detail: 'No price or availability could be verified for the requested Amazon listing.' };
  }

  // Construct a small DOM rather than trusting page-wide selectors, JSON-LD,
  // regexes or AI with other variants' prices and stock.
  const scoped = load('<html><head></head><body><main></main></body></html>');
  const language = $('html').attr('lang');
  if (language) scoped('html').attr('lang', language);
  const main = scoped('main');
  const title = $('#productTitle').first().text().trim();
  if (title) main.append(scoped('<span id="productTitle"></span>').text(title));
  const image = $('#landingImage').first().attr('src');
  if (image) main.append(scoped('<img id="landingImage">').attr('src', image));
  if (priceAsin === requested && prices.length === 1) {
    const price = scoped('<div id="corePrice_feature_div"><span class="a-price apex-pricetopay-value"><span class="a-offscreen"></span></span></div>');
    price.find('.a-offscreen').text(prices[0]);
    main.append(price);
  }
  if (stockText) main.append(scoped('<div id="availabilityInsideBuyBox_feature_div"><div id="availability"></div></div>').find('#availability').text(stockText).end());

  const stock = load('<html><body><main><div id="availability"></div></main></body></html>');
  stock('#availability').text(stockText);
  return { kind: 'scoped', html: scoped.html(), stockHtml: stockText ? stock.html() : '' };
}
