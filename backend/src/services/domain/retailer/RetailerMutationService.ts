import { retailerRepository, RetailerConfig, RETAILER_BROWSER_ENGINES } from '../../../models';
import { configCache } from '../../../utils/cache';
import { logger } from '../../../utils/system/logger';
import { RetailerQueryService } from './RetailerQueryService';

/**
 * Carries `statusCode` so `asyncHandler` answers 400 with this message rather
 * than letting the database CHECK constraint surface as a generic 500.
 */
export class InvalidBrowserEngineError extends Error {
  readonly statusCode = 400;

  constructor(value: unknown) {
    super(`browser_engine must be one of: ${RETAILER_BROWSER_ENGINES.join(', ')} (got ${JSON.stringify(value)})`);
    this.name = 'InvalidBrowserEngineError';
  }
}

export class RetailerMutationService {
  constructor(private queryService: RetailerQueryService) {}

  /**
   * Add or update a retailer configuration
   */
  async upsertRetailer(config: any): Promise<RetailerConfig | null> {
    const { domain, forceNameRemoval } = config;
    if (!domain) {
      throw new Error('Domain is required');
    }
    const engine = config.browser_engine;
    if (engine != null && !(RETAILER_BROWSER_ENGINES as readonly unknown[]).includes(engine)) {
      throw new InvalidBrowserEngineError(engine);
    }

    const updated = await retailerRepository.upsert({ ...config, forceNameRemoval });

    // Invalidate cache
    configCache.invalidate(domain);
    
    const manualTrace: string[] = [
      `Name: ${updated.name || 'Unknown'}`,
      `Domain: ${updated.domain}`,
      `Active: ${updated.active ? 'Yes' : 'No'}`,
      `Engine: ${updated.use_browser_scraper ? `Browser Scraper (${updated.browser_engine})` : 'Standard (HTTP)'}`
    ];
    if (updated.name_selectors?.length > 0) manualTrace.push(`Name Selectors: ${JSON.stringify(updated.name_selectors)}`);
    if (updated.price_selectors?.length > 0) manualTrace.push(`Price Selectors: ${JSON.stringify(updated.price_selectors)}`);
    if (updated.deal_price_selectors?.length > 0) manualTrace.push(`Deal Price Selectors: ${JSON.stringify(updated.deal_price_selectors)}`);
    if (updated.member_price_selectors?.length > 0) manualTrace.push(`Member Price Selectors: ${JSON.stringify(updated.member_price_selectors)}`);
    if (updated.original_price_selectors?.length > 0) manualTrace.push(`Original Price Selectors: ${JSON.stringify(updated.original_price_selectors)}`);
    if (updated.image_selectors?.length > 0) manualTrace.push(`Image Selectors: ${JSON.stringify(updated.image_selectors)}`);
    if (updated.stock_selectors?.length > 0) manualTrace.push(`Stock Selectors: ${JSON.stringify(updated.stock_selectors)}`);
    if (updated.exclusion_selectors?.length > 0) manualTrace.push(`Exclusion Selectors: ${JSON.stringify(updated.exclusion_selectors)}`);
    
    const jsonldKeys = [];
    if (updated.jsonld_name_key) jsonldKeys.push(`name: ${updated.jsonld_name_key}`);
    if (updated.jsonld_price_key) jsonldKeys.push(`price: ${updated.jsonld_price_key}`);
    if (updated.jsonld_image_key) jsonldKeys.push(`image: ${updated.jsonld_image_key}`);
    if (jsonldKeys.length > 0) {
      manualTrace.push(`JSON-LD Keys: { ${jsonldKeys.join(', ')} }`);
    }

    const settingsList = [];
    if (updated.use_proxy) settingsList.push('Proxy');
    if (settingsList.length > 0) {
      manualTrace.push(`Settings: ${settingsList.join(', ')}`);
    }

    logger.info(`Retailer ${domain} | Config Saved | Manual update`, 'Retailers', {
      trace: manualTrace
    });

    return updated;
  }

  /**
   * Delete a retailer configuration
   */
  async deleteRetailer(id: number): Promise<boolean> {
    // Get domain before delete for cache invalidation
    const retailers = await this.queryService.getAllRetailers(false);
    const target = retailers.find(r => r.id === id);

    const deleted = await retailerRepository.delete(id);
    if (!deleted) return false;

    if (target) {
      configCache.invalidate(target.domain);
      logger.info(`Retailer ${target.domain} | Config Deleted`, 'Retailers');
    }

    return true;
  }
}
