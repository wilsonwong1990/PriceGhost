import { productRepository, ProductWithLatestPrice } from '../../../../models';
import { productPersistenceService } from '../ProductPersistenceService';
import { logger } from '../../../../utils/system/logger';
import { FALLBACK_REFRESH_INTERVAL_SECONDS } from '../../../../utils/system/check-interval';
import { assertUrlIsSafe } from '../../../../utils/system/url-safety';
import { scrapeProductWithVoting } from '../../../scraper';
import { AMAZON_CART_METHOD, amazonTarget } from '../../../scraper/acquisition/amazon';

function isCartSelection(url: string, method: unknown): boolean {
  if (method !== AMAZON_CART_METHOD) return false;
  if (amazonTarget(url)) return true;
  const error: Error & { statusCode?: number } = new Error('Amazon cart pricing requires a supported Amazon product URL');
  error.statusCode = 400;
  throw error;
}

function rejectStaleSelection(ignored?: boolean): void {
  if (!ignored) return;
  const error: Error & { statusCode?: number } = new Error(
    'This product now requires a verified Amazon cart price. Refresh it before choosing a price.'
  );
  error.statusCode = 409;
  throw error;
}

async function verifyCartSelection(
  userId: number,
  url: string,
  selectedPrice: unknown,
  selectedCurrency: unknown,
  productId?: number,
  lastChecked?: Date | null,
) {
  if (typeof selectedPrice !== 'number' || !Number.isFinite(selectedPrice) || selectedPrice <= 0 ||
      typeof selectedCurrency !== 'string' || !selectedCurrency) {
    const error: Error & { statusCode?: number } = new Error('A price and currency are required to confirm a product');
    error.statusCode = 400;
    throw error;
  }
  await assertUrlIsSafe(url, { policy: 'allow-private-lan' });
  const scraped = await scrapeProductWithVoting(
    url, userId, AMAZON_CART_METHOD, undefined, undefined, undefined, undefined, productId, { allowAmazonCart: true }
  );
  const observation = scraped.amazonCartObservation;
  const markUnverified = async () => {
    if (productId === undefined) return;
    const reason = scraped.unavailableReason || 'amazon_cart_price_unavailable';
    await productPersistenceService.rememberAmazonCartRequirement(productId, userId, reason, lastChecked);
  };
  if (!scraped.amazonCartRequired || !observation || scraped.needsReview ||
      !scraped.price || scraped.price.price !== observation.price ||
      scraped.price.currency !== observation.currency) {
    await markUnverified();
    const error: Error & { statusCode?: number } = new Error(
      'The Amazon cart price could not be verified again. Refresh and try again.'
    );
    error.statusCode = 409;
    throw error;
  }
  if (scraped.price.price !== selectedPrice || scraped.price.currency !== selectedCurrency) {
    await markUnverified();
    const error: Error & { statusCode?: number } = new Error(
      'The Amazon cart price changed. Refresh before confirming it.'
    );
    error.statusCode = 409;
    throw error;
  }
  return scraped;
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
    const cartRequired = isCartSelection(url, selectedMethod);
    const verifiedCart = cartRequired
      ? await verifyCartSelection(userId, url, selectedPrice, selectedCurrency)
      : null;

    const product = await productRepository.create(
      userId,
      url,
      verifiedCart ? verifiedCart.name?.substring(0, 255) || null : name ? name.substring(0, 255) : null,
      verifiedCart ? verifiedCart.imageUrl || null : imageUrl || null,
      refresh_interval || FALLBACK_REFRESH_INTERVAL_SECONDS,
      verifiedCart ? verifiedCart.stockStatus : stockStatus || 'unknown',
      cartRequired ? null : 'confirmed',
      category || null,
      cartRequired ? AMAZON_CART_METHOD : null
    );

    const persistence = await productPersistenceService.saveScrapeResult(
      product.id, 
      userId, 
      verifiedCart || {
        ...options,
        price: { price: selectedPrice, currency: selectedCurrency },
        memberPrice,
        originalPrice,
        selectedMethod,
        html,
        amazonCartRequired: false,
        amazonCartObservation: undefined,
        needsReview: false,
      } as any, 
      'manual-add',
      manualSelector
    );
    rejectStaleSelection(persistence?.ignored);

    return await productRepository.findById(product.id, userId);
  }

  /**
   * Confirms a user's selection for an existing product (re-voting).
   */
  async confirmProductSelection(userId: number, productId: number, selection: any): Promise<ProductWithLatestPrice | null> {
    const product = await productRepository.findById(productId, userId);
    if (!product) throw new Error('Product not found');

    const { selectedPrice, selectedCurrency, selectedMethod, memberPrice, originalPrice } = selection;
    const cartRequired = isCartSelection(product.url, selectedMethod) ||
      product.preferred_extraction_method === AMAZON_CART_METHOD;
    if (selectedPrice !== undefined && !selectedCurrency) {
      const err: Error & { statusCode?: number } = new Error('A currency is required when confirming a price');
      err.statusCode = 400;
      throw err;
    }

    if (cartRequired && selectedMethod !== AMAZON_CART_METHOD) {
      const error: Error & { statusCode?: number } = new Error(
        'This product requires a verified Amazon cart price. Refresh it before choosing a price.'
      );
      error.statusCode = 409;
      throw error;
    }
    if (cartRequired && product.preferred_extraction_method !== AMAZON_CART_METHOD) {
      await productPersistenceService.rememberAmazonCartRequirement(productId, userId);
    }
    const verifiedCart = cartRequired
      ? await verifyCartSelection(userId, product.url, selectedPrice, selectedCurrency, productId, product.last_checked)
      : null;
    const persistence = await productPersistenceService.saveScrapeResult(
      productId,
      userId,
      verifiedCart || {
        ...selection,
        price: selectedPrice !== undefined ? { price: selectedPrice, currency: selectedCurrency } : undefined,
        memberPrice,
        originalPrice,
        selectedMethod,
        amazonCartRequired: false,
        amazonCartObservation: undefined,
        needsReview: false,
      } as any,
      verifiedCart ? 'refresh' : 'manual-confirm',
      selection.selector
    );
    rejectStaleSelection(persistence?.ignored);

    if (product.checking_paused) {
      logger.info(`Product ${productId} | Status | Unpausing checking after manual selection confirmation.`, 'Products', { product_id: productId });
      await productRepository.bulkSetCheckingPaused([productId], userId, false);
    }

    return await productRepository.findById(productId, userId);
  }
}

export const productConfirmationService = new ProductConfirmationService();
