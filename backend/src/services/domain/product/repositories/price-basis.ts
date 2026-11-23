// Restrict Amazon cart price comparisons to verified cart observations.
import { AMAZON_CART_BASIS, AMAZON_CART_METHOD } from '../../../scraper/acquisition/amazon';

export const HISTORY_PRICE_BASIS = `(p.preferred_extraction_method IS DISTINCT FROM '${AMAZON_CART_METHOD}'
  OR history.details->>'price_basis' = '${AMAZON_CART_BASIS}')`;

export const CURRENT_PRICE_BASIS = `(${HISTORY_PRICE_BASIS}
  AND (p.preferred_extraction_method IS DISTINCT FROM '${AMAZON_CART_METHOD}' OR p.unavailable_reason IS NULL))`;
