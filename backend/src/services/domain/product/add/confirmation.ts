import { productRepository, ProductWithLatestPrice } from '../../../../models';
import { productPersistenceService } from '../ProductPersistenceService';
import { logger } from '../../../../utils/system/logger';
import { FALLBACK_REFRESH_INTERVAL_SECONDS } from '../../../../utils/system/check-interval';
import { assertUrlIsSafe } from '../../../../utils/system/url-safety';
import { scrapeProductWithVoting } from '../../../scraper';
import { isAmazonUrl } from '../../../scraper/extractors/amazon-scope';
import type { PriceCandidate, ScrapedProductWithVoting } from '../../../../types/scraper';

async function verifyAmazonSelection(
  url: string,
  userId: number,
  price: number,
  currency: string,
  method: string,
  productId?: number
): Promise<{ scraped: ScrapedProductWithVoting; candidate: PriceCandidate } | null> {
  if (!isAmazonUrl(url) || method === 'manual') return null;
  await assertUrlIsSafe(url, { policy: 'allow-private-lan' });
  const scraped = await scrapeProductWithVoting(url, userId, undefined, undefined, undefined, undefined, undefined, productId);
  const candidate = scraped.priceCandidates.find(c =>
    c.price === price && (!c.currency || c.currency === currency) && c.method === method
  );
  if (scraped.failureReason || scraped.unavailableReason || !candidate) {
    const error: Error & { statusCode?: number } = new Error('Amazon could not confirm this price for the selected option. Rescan the listing or use the selected option’s product URL.');
    error.statusCode = 400;
    throw error;
  }
  return { scraped, candidate };
}

export class ProductConfirmationService {
  /**
   * Creates and confirms a product when the client provides a pre-selected candidate.
   */
  async confirmNewProduct(userId: number, url: string, options: any) {
    const { 
      refresh_interval, 
      selectedPrice, 
      selectedMethod, 
      selectedCurrency, 
      category,
      name,
      imageUrl,
      stockStatus,
      html,
      selector: manualSelector,
      memberPrice,
      originalPrice
    } = options;
    if (typeof selectedPrice !== 'number' || !selectedCurrency) {
      const err: Error & { statusCode?: number } = new Error('A price and currency are required to confirm a product');
      err.statusCode = 400;
      throw err;
    }

    const amazon = isAmazonUrl(url);
    if (amazon && (!Number.isFinite(selectedPrice) || selectedPrice <= 0)) {
      const err: Error & { statusCode?: number } = new Error('A valid price is required to confirm an Amazon listing');
      err.statusCode = 400;
      throw err;
    }
    const verified = await verifyAmazonSelection(url, userId, selectedPrice, selectedCurrency, selectedMethod);
    const product = await productRepository.create(
      userId,
      url,
      amazon ? verified?.scraped.name?.substring(0, 255) || null : name ? name.substring(0, 255) : null,
      amazon ? verified?.scraped.imageUrl || null : imageUrl || null,
      refresh_interval || FALLBACK_REFRESH_INTERVAL_SECONDS,
      (amazon ? verified?.scraped.stockStatus || 'unknown' : stockStatus || 'unknown') as any,
      'confirmed',
      category || null
    );

    await productPersistenceService.saveScrapeResult(
      product.id, 
      userId, 
      {
        ...options,
        ...(verified?.scraped || {}),
        ...(amazon && !verified ? { name: null, imageUrl: null } : {}),
        price: { price: selectedPrice, currency: selectedCurrency },
        memberPrice: amazon ? verified?.scraped.memberPrice : memberPrice,
        originalPrice: amazon ? verified?.scraped.originalPrice : originalPrice,
        stockStatus: amazon ? verified?.scraped.stockStatus || 'unknown' : stockStatus,
        ...(amazon ? { needsReview: false } : {}),
        selectedMethod,
        html: amazon ? verified?.scraped.html : html
      } as any, 
      'manual-add',
      amazon ? verified?.candidate.selector : manualSelector
    );

    return await productRepository.findById(product.id, userId);
  }

  /**
   * Confirms a user's selection for an existing product (re-voting).
   */
  async confirmProductSelection(userId: number, productId: number, selection: any): Promise<ProductWithLatestPrice | null> {
    const product = await productRepository.findById(productId, userId);
    if (!product) throw new Error('Product not found');

    const { selectedPrice, selectedCurrency, selectedMethod, memberPrice, originalPrice } = selection;
    if (selectedPrice !== undefined && !selectedCurrency) {
      const err: Error & { statusCode?: number } = new Error('A currency is required when confirming a price');
      err.statusCode = 400;
      throw err;
    }

    const amazon = isAmazonUrl(product.url);
    if (amazon && (typeof selectedPrice !== 'number' || !Number.isFinite(selectedPrice) || selectedPrice <= 0)) {
      const err: Error & { statusCode?: number } = new Error('A valid price is required to confirm an Amazon listing');
      err.statusCode = 400;
      throw err;
    }
    const verified = selectedPrice === undefined ? null
      : await verifyAmazonSelection(product.url, userId, selectedPrice, selectedCurrency, selectedMethod, productId);
    await productPersistenceService.saveScrapeResult(
      productId,
      userId,
      {
        ...selection,
        ...(verified?.scraped || {}),
        ...(amazon && !verified ? { name: null, imageUrl: null } : {}),
        price: selectedPrice !== undefined ? { price: selectedPrice, currency: selectedCurrency } : undefined,
        memberPrice: amazon ? verified?.scraped.memberPrice : memberPrice,
        originalPrice: amazon ? verified?.scraped.originalPrice : originalPrice,
        stockStatus: amazon ? verified?.scraped.stockStatus || 'unknown' : selection.stockStatus,
        html: amazon ? verified?.scraped.html : selection.html,
        ...(amazon ? { needsReview: false } : {}),
        selectedMethod
      } as any,
      'manual-confirm',
      amazon ? verified?.candidate.selector : selection.selector
    );

    // EXPLICITLY clear needs_price_review and update checking status
    await productRepository.update(productId, userId, {
      needs_price_review: false,
      ai_status: 'confirmed'
    });

    if (product.checking_paused) {
      logger.info(`Product ${productId} | Status | Unpausing checking after manual selection confirmation.`, 'Products', { product_id: productId });
      await productRepository.bulkSetCheckingPaused([productId], userId, false);
    }

    return await productRepository.findById(productId, userId);
  }
}

export const productConfirmationService = new ProductConfirmationService();
