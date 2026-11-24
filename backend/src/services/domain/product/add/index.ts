import { productRepository } from '../../../../models';
import { cleanUrl } from '../../../../utils/scraping/urlHelper';
import { productDiscoveryService } from './discovery';
import { productConfirmationService } from './confirmation';
import { productRescanService } from './rescan';
import { defaultCheckIntervalService } from '../DefaultCheckIntervalService';
import { AMAZON_CART_METHOD, amazonTarget } from '../../../scraper/acquisition/amazon';

export class ProductAddService {
  /**
   * Main entry point for adding a product.
   */
  async addProduct(userId: number, url: string, options: any): Promise<any> {
    const wantsCart = options.amazonCart === true || options.selectedMethod === AMAZON_CART_METHOD;
    const target = wantsCart ? amazonTarget(url.trim()) : null;
    if (wantsCart && !target) {
      const error: Error & { statusCode?: number } = new Error('Amazon cart pricing requires a plain Amazon.com or Amazon.com.au product URL without an offer or variant selection');
      error.statusCode = 400;
      throw error;
    }
    if (options.amazonCart === true && options.selectedPrice !== undefined && options.selectedMethod !== AMAZON_CART_METHOD) {
      const error: Error & { statusCode?: number } = new Error('Amazon cart pricing requires a verified cart selection');
      error.statusCode = 400;
      throw error;
    }
    const cleanedUrl = target?.productUrl || cleanUrl(url);
    
    // Check for duplicate
    let existingId = await productRepository.findDuplicateUrl(cleanedUrl, userId);
    const duplicateTarget = amazonTarget(cleanedUrl.replace(/#unverified-amazon-selection$/, ''));
    if (!existingId && duplicateTarget) {
      const alternate = /^\/gp\/product\//i.test(new URL(cleanedUrl).pathname)
        ? duplicateTarget.productUrl
        : duplicateTarget.productUrl.replace('/dp/', '/gp/product/');
      existingId = await productRepository.findDuplicateUrl(alternate, userId);
    }
    if (existingId) {
      const err = new Error('Duplicate product');
      (err as any).statusCode = 409;
      (err as any).existingProductId = existingId;
      throw err;
    }

    const { selectedPrice, selectedMethod, category: rawCategory, refresh_interval } = options;
    const category = rawCategory?.trim() || null;

    // Resolved once, here, so both paths below create the product with the same
    // interval and neither needs its own fallback (issue #239). An interval the
    // request carried wins; otherwise this is the user's default, then the
    // instance default, then 12 hours.
    const refreshInterval = await defaultCheckIntervalService.resolveForNewProduct(userId, refresh_interval);

    if (selectedPrice !== undefined && selectedMethod) {
      return productConfirmationService.confirmNewProduct(userId, cleanedUrl, {
        ...options,
        refresh_interval: refreshInterval,
      });
    } 
    
    return productDiscoveryService.initiateProductDiscovery(userId, cleanedUrl, category, refreshInterval, wantsCart);
  }

  async scanProduct(userId: number, productId: number, amazonCart = false): Promise<any> {
    return productRescanService.scanProduct(userId, productId, amazonCart);
  }

  async confirmProductSelection(userId: number, productId: number, selection: any) {
    return productConfirmationService.confirmProductSelection(userId, productId, selection);
  }
}

export const productAddService = new ProductAddService();
export * from './discovery';
export * from './confirmation';
export * from './rescan';
