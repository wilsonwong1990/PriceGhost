import { 
  productRepository, 
  Product,
} from '../../../models';
import { scrapeProductWithVoting } from '../../scraper';
import { ExtractionMethod } from '../../../types/scraper';
import { logger } from '../../../utils/system/logger';
import { productNotificationService } from './notifications/index';
import { productPersistenceService } from './ProductPersistenceService';
import { PAGE_GONE_THRESHOLD, isDefinitiveUnavailable, describeUnavailableReason } from '../../../types/availability';
import { assertUrlIsSafe, UnsafeUrlError } from '../../../utils/system/url-safety';
import { StockStatus } from '../../../models/types/base';
import { AMAZON_CART_METHOD, isAmazonMarketplaceUrl } from '../../scraper/acquisition/amazon';

/**
 * Consecutive transport failures before the user is told the retailer looks
 * unreachable.
 *
 * Higher than the page-gone threshold, and deliberately does not pause: a
 * timeout is evidence about the network, not about the product, so the right
 * response is to keep trying and say so once it stops looking like a blip.
 */
const SITE_FAILURE_NOTIFY_THRESHOLD = 6;

/**
 * Which previous statuses make a move to `in_stock` worth announcing.
 *
 * `member_only` is included, and was not before (issue #92). From the user's
 * side it is the same event as any other on this list: the item exists, they
 * could not buy it, and now they can. Leaving it out meant a members-only
 * product opening to everyone passed silently.
 *
 * `unknown` stays out deliberately. It does not mean the item was unavailable,
 * it means the last scrape could not tell -- so treating it as a transition
 * would fire "back in stock" on the first successful scrape after any parse
 * failure, for a product that had been in stock the whole time. `null` is out
 * for the same reason: a product that has never had a status is not a product
 * that has come back.
 */
const BACK_IN_STOCK_FROM: readonly StockStatus[] = ['out_of_stock', 'pre_order', 'not_available', 'member_only'];

export function isBackInStockFrom(previous: StockStatus | null): boolean {
  return previous !== null && BACK_IN_STOCK_FROM.includes(previous);
}

export class ProductRefreshService {
  /**
   * Refreshes a product by scraping its URL and updating its state.
   * Orchestrates notifications for price drops and stock changes.
   */
  async refreshProduct(product: Product): Promise<any> {
    const productId = product.id;
    const userId = product.user_id;

    const preferredMethod = await productRepository.getPreferredExtractionMethod(productId);
    const anchorPrice = await productRepository.getAnchorPrice(productId);
    const skipAiVerification = await productRepository.isAiVerificationDisabled(productId);
    const skipAiExtraction = await productRepository.isAiExtractionDisabled(productId);

    // A stored URL is not a trusted URL: rows added before the guard existed
    // were never checked, and a hostname that was public when the product was
    // added can be repointed at an internal address afterwards -- which on
    // this path would be fetched on a schedule, unattended, forever (issue
    // #165). Same lenient policy as adding a product, so a shop on the user's
    // own LAN keeps working.
    //
    // A host that simply does not resolve is deliberately allowed through to
    // the scraper: DNS failure is a transient condition this method already
    // records, counts and eventually notifies on a few lines below, and
    // throwing here would replace that with a bare scheduler log.
    try {
      await assertUrlIsSafe(product.url, { policy: 'allow-private-lan' });
    } catch (error) {
      if (!(error instanceof UnsafeUrlError) || error.reason !== 'unresolvable') throw error;
    }

    // 1. Scrape
    const scrapedData = await scrapeProductWithVoting(
      product.url,
      userId,
      preferredMethod as ExtractionMethod | undefined,
      anchorPrice || undefined,
      skipAiVerification,
      skipAiExtraction,
      undefined,
      productId,
      { allowAmazonCart: true }
    );

    // 1.5 Separate two things that used to be conflated.
    //
    // A *definitive* result -- 404, 410, a redirect to the home page, a soft 404
    // -- is evidence about the product, and after a streak it pauses monitoring
    // and tells the user. Bot walls serve 404 for a while, hence the streak.
    //
    // A *transient* failure -- timeout, DNS, refused connection, a bot challenge
    // -- is evidence about the network or the retailer. It previously produced
    // `unknown`, which preserved the status, counted nothing and recorded
    // nothing, so a retailer could be down for a week leaving no trace. It now
    // counts separately, never pauses, and never marks a product gone.
    const reason = scrapedData.unavailableReason;
    const isDefinitive = isDefinitiveUnavailable(reason);
    const isTransient = !!reason && !isDefinitive;
    const amazonRefresh = isAmazonMarketplaceUrl(product.url) ||
      preferredMethod === AMAZON_CART_METHOD || scrapedData.amazonCartRequired === true;

    if (isTransient && !amazonRefresh) {
      const failures = await productRepository.recordFailure(productId, reason!);
      logger.warn(
        `Product ${productId} | Availability | ${describeUnavailableReason(reason)} (failure ${failures}). Status unchanged.`,
        'Products',
        { product_id: productId }
      );
      if (failures === SITE_FAILURE_NOTIFY_THRESHOLD) {
        // Once, on crossing the threshold -- not every scrape thereafter.
        await productNotificationService.notifyNotAvailable(product, reason!, false, failures);
      }
    } else if (isDefinitive && !amazonRefresh && product.stock_status !== 'not_available') {
      const streak = (product.page_gone_streak || 0) + 1;
      await productRepository.setPageGoneStreak(productId, streak);
      await productRepository.setUnavailableReason(productId, reason!);
      if (streak < PAGE_GONE_THRESHOLD) {
        logger.warn(`Product ${productId} | Status | ${describeUnavailableReason(reason)} (${streak}/${PAGE_GONE_THRESHOLD} consecutive). Keeping status '${product.stock_status}' until the streak completes.`, 'Products', { product_id: productId });
        scrapedData.stockStatus = product.stock_status;
      }
    } else if (!reason && !amazonRefresh) {
      // The page was actually read, so any previous failure state is stale.
      if (product.page_gone_streak) await productRepository.setPageGoneStreak(productId, 0);
      await productRepository.clearFailureState(productId);
    }

    // 2. Persist results (DB State Sync)
    //
    // The transition comes back from inside the advisory lock. The check below
    // used to compare against `product.stock_status`, read before the scrape
    // and outside any lock, so two concurrent refreshes of the same product
    // both saw `out_of_stock` and both sent a back-in-stock alert for one
    // event. Only the refresh that actually wrote the change sees it here.
    const transitions = await productPersistenceService.saveScrapeResult(productId, userId, scrapedData, 'refresh');
    if (transitions?.ignored) {
      return { stockStatus: 'unknown', aiStatus: null, status: 'superseded' };
    }
    if (isTransient && amazonRefresh && transitions?.failureStreak !== undefined) {
      const failures = transitions.failureStreak;
      logger.warn(
        `Product ${productId} | Availability | ${describeUnavailableReason(reason)} (failure ${failures}). Status unchanged.`,
        'Products',
        { product_id: productId }
      );
      if (failures === SITE_FAILURE_NOTIFY_THRESHOLD) {
        await productNotificationService.notifyNotAvailable(product, reason!, false, failures);
      }
    }
    const transition = transitions?.stock;

    // Resume only a pause the system applied. A user who deliberately paused a
    // product does not want it silently resumed because the page came back --
    // that decision is theirs, and previously it was overridden.
    if (product.checking_paused && product.auto_paused && !reason && scrapedData.stockStatus !== 'not_available') {
      logger.info(`Product ${productId} | Status | Page is available again. Resuming checks.`, 'Products', { product_id: productId });
      await productRepository.setPaused(productId, false, false);
      if (!amazonRefresh) await productRepository.setUnavailableReason(productId, null);
      product.checking_paused = false;
      // Close the loop. Without this the lifecycle only ever reports bad news:
      // the user was told monitoring stopped and never told it started again.
      await productNotificationService.notifyProductRestored(product);
    }

    // 3. Handle Notifications (Side-effects of change)
    if (transition) {
      if (transition.to === 'not_available') {
        logger.warn(`Product ${productId} | Status | ${describeUnavailableReason(reason)}. Pausing further checks.`, 'Products', { product_id: productId });
        await productRepository.setPaused(productId, true, false);
        await productNotificationService.notifyNotAvailable(
          product, reason, true, transitions?.pageGoneStreak ?? (product.page_gone_streak || 0) + 1
        );
      } else if (transition.to === 'in_stock' && isBackInStockFrom(transition.from) && product.notify_back_in_stock) {
        const priceUnverified = scrapedData.needsReview || (scrapedData.amazonCartRequired && !scrapedData.amazonCartObservation);
        await productNotificationService.notifyBackInStock(
          product, priceUnverified ? { ...scrapedData, price: null } : scrapedData, transition.from
        );
      }
    }

    if (transitions?.price) {
      const { previousPrice, currentPrice } = transitions.price;
      // Check if this was a pre-order product with no prior recorded price
      const isPreOrderNoPrice = !scrapedData.amazonCartRequired &&
        product.stock_status === 'pre_order' && !transitions.price.hadPreviousPrice;
      if (isPreOrderNoPrice) {
        await productNotificationService.notifyPriceAnnounced(product, currentPrice);
      }

      if (previousPrice !== null && product.price_drop_threshold) {
        await productNotificationService.notifyPriceDrop(product, previousPrice, currentPrice);
      }
      if (product.target_price) {
        await productNotificationService.notifyTargetHit(product, previousPrice, currentPrice);
      }
      const statusLabel = scrapedData.aiStatus === 'confirmed' ? ' (System confirmed)' : (scrapedData.aiStatus ? ` (AI: ${scrapedData.aiStatus})` : '');
      logger.info(`Product ${productId} | Price | Updated to ${currentPrice.currency} ${currentPrice.price}${statusLabel}`, 'Products', { product_id: productId });
    }

    const cartVerified = !!scrapedData.amazonCartObservation && !scrapedData.needsReview &&
      scrapedData.price?.price === scrapedData.amazonCartObservation.price &&
      scrapedData.price?.currency === scrapedData.amazonCartObservation.currency;
    return {
      stockStatus: scrapedData.amazonCartRequired ? 'unknown' : scrapedData.stockStatus,
      aiStatus: scrapedData.aiStatus,
      status: scrapedData.amazonCartRequired && !cartVerified
        ? 'unavailable' : 'ok',
    };
  }
}

export const productRefreshService = new ProductRefreshService();
