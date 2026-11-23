import { productRepository } from '../../../../models';
import { scrapeProductWithVoting } from '../../../scraper';
import { assertUrlIsSafe } from '../../../../utils/system/url-safety';
import { AMAZON_CART_METHOD, amazonTarget } from '../../../scraper/acquisition/amazon';
import { productPersistenceService } from '../ProductPersistenceService';

export class ProductRescanService {
  /**
   * Scans an existing product to show the voting modal again.
   */
  async scanProduct(userId: number, productId: number, amazonCart = false): Promise<any> {
    const product = await productRepository.findById(productId, userId);
    if (!product) throw new Error('Product not found');

    // The URL is stored rather than typed here, but a row added before the
    // guard existed was never checked, and a hostname's DNS answer can change
    // after the fact. This is a user-triggered fetch like any other, so it is
    // checked at the point of use (issue #165).
    await assertUrlIsSafe(product.url, { policy: 'allow-private-lan' });

    if (amazonCart && !amazonTarget(product.url)) {
      const error: Error & { statusCode?: number } = new Error('Amazon cart pricing requires a plain Amazon.com or Amazon.com.au product URL without an offer or variant selection');
      error.statusCode = 400;
      throw error;
    }
    if (amazonCart) {
      await productPersistenceService.rememberAmazonCartRequirement(productId, userId);
    }
    const scrapedData = await scrapeProductWithVoting(
      product.url, 
      userId, 
      amazonCart || product.preferred_extraction_method === AMAZON_CART_METHOD ? AMAZON_CART_METHOD : undefined,
      undefined, undefined, undefined, undefined,
      productId,
      { allowAmazonCart: true }
    );
    if (scrapedData.amazonCartRequired) {
      await productPersistenceService.rememberAmazonCartRequirement(
        productId,
        userId,
        scrapedData.amazonCartObservation ? undefined : scrapedData.unavailableReason || 'amazon_cart_price_unavailable',
        scrapedData.amazonCartObservation ? undefined : product.last_checked,
      );
    }

    const candidates: any[] = scrapedData.priceCandidates.map(c => ({
      price: c.price,
      currency: c.currency,
      method: c.method,
      context: c.context,
      confidence: c.confidence,
      selector: c.selector,
    }));

    if (scrapedData.memberPrice?.price) {
      candidates.push({
        price: scrapedData.memberPrice.price,
        currency: scrapedData.memberPrice.currency,
        method: 'member-price',
        context: 'Member / loyalty price',
        confidence: 0.90,
        selector: undefined
      });
    }

    if (scrapedData.originalPrice?.price) {
      candidates.push({
        price: scrapedData.originalPrice.price,
        currency: scrapedData.originalPrice.currency,
        method: 'original-price',
        context: 'Original / RRP price',
        confidence: 0.85,
        selector: undefined
      });
    }

    return {
      needsReview: true,
      name: scrapedData.name ? scrapedData.name.substring(0, 255) : null,
      imageUrl: scrapedData.imageUrl,
      stockStatus: scrapedData.stockStatus,
      priceCandidates: candidates,
      reviewReason: 'manual_rescan',
      amazonCartRequired: scrapedData.amazonCartRequired === true,
      url: product.url,
      id: productId,
      html: scrapedData.html ? scrapedData.html.substring(0, 100_000) : null
    };
  }
}

export const productRescanService = new ProductRescanService();
