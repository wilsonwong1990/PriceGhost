import { describe, expect, it } from 'vitest';
import { load } from 'cheerio';
import { scopeAmazonPage } from '../../src/services/scraper/extractors/amazon-scope';

const asin = 'B012345678';
const other = 'B098765432';
const url = `https://www.amazon.com/dp/${asin}`;

function page(overrides: { displayed?: string; selected?: string; priceAsin?: string; stockAsin?: string } = {}) {
  return load(`
    <html lang="en-US"><body>
      <input id="ASIN" value="${overrides.displayed ?? asin}">
      <span id="productTitle">Example shoes</span>
      <div id="inline-twister-row-size_name">
        <li data-asin="${overrides.selected ?? asin}"><input aria-checked="true"></li>
        <li data-asin="${other}"><input aria-checked="false"><span class="a-price">$12.00</span></li>
      </div>
      <div id="corePrice_feature_div" data-csa-c-asin="${overrides.priceAsin ?? asin}">
        <span class="a-price apex-pricetopay-value"><span class="a-offscreen">$78.00</span></span>
      </div>
      <div id="availabilityInsideBuyBox_feature_div" data-csa-c-asin="${overrides.stockAsin ?? asin}">
        <div id="availability">Out of stock</div>
      </div>
      <div data-asin="${other}"><span class="a-price">$9.00</span>In stock</div>
      <script type="application/ld+json">{"@type":"ProductGroup","offers":{"lowPrice":5}}</script>
    </body></html>
  `);
}

describe('Amazon selected listing scope', () => {
  it('keeps only the selected product price and availability', () => {
    const result = scopeAmazonPage(url, page());
    expect(result.kind).toBe('scoped');
    if (result.kind !== 'scoped') return;
    expect(result.html).toContain('$78.00');
    expect(result.html).toContain('Out of stock');
    expect(result.html).not.toContain('$12.00');
    expect(result.html).not.toContain('$9.00');
    expect(result.html).not.toContain('lowPrice');
    expect(result.stockHtml).toContain('Out of stock');
    expect(result.stockHtml).not.toContain('In stock');
  });

  it('rejects a page that changed the requested ASIN or selected another size', () => {
    expect(scopeAmazonPage(url, page({ displayed: other })).kind).toBe('ambiguous');
    expect(scopeAmazonPage(url, page({ selected: other })).kind).toBe('ambiguous');
    expect(scopeAmazonPage(url, page({ priceAsin: other })).kind).toBe('ambiguous');
  });

  it('rejects an unselected size and a conflicting nested product', () => {
    const missing = page();
    missing('[aria-checked]').attr('aria-checked', 'false');
    expect(scopeAmazonPage(url, missing).kind).toBe('ambiguous');

    const mixed = page();
    mixed('#corePrice_feature_div').append(`<div data-asin="${other}">$5.00</div>`);
    expect(scopeAmazonPage(url, mixed).kind).toBe('ambiguous');
  });

  it('rejects legacy options mixed with inline rows and a conflicting offer ancestor', () => {
    const mixed = page();
    mixed('body').append('<div id="variation_color_name"><select><option>Another colour</option></select></div>');
    expect(scopeAmazonPage(url, mixed).kind).toBe('ambiguous');

    const nested = page();
    nested('#corePrice_feature_div').wrap(`<div data-asin="${other}"></div>`);
    expect(scopeAmazonPage(url, nested).kind).toBe('ambiguous');
  });

  it('does not trust an untagged price or another listing’s availability', () => {
    const result = scopeAmazonPage(url, page({ priceAsin: '', stockAsin: other }));
    expect(result.kind).toBe('ambiguous');
  });

  it('leaves other retailers unchanged and rejects unknown Amazon variation controls', () => {
    expect(scopeAmazonPage('https://amazon.com.example.org/dp/B012345678', page()).kind).toBe('other');
    expect(scopeAmazonPage('https://smile.amazon.com/dp/B012345678', page({ displayed: other })).kind).toBe('ambiguous');
    const legacy = page();
    legacy('[id^="inline-twister-row-"]').remove();
    legacy('body').append('<div id="twister"></div>');
    expect(scopeAmazonPage(url, legacy).kind).toBe('ambiguous');
  });
});
