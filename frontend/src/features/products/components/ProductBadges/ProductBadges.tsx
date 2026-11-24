import React from 'react';
import { Product } from '../../../../types/api';
import AIStatusBadge from '../../../../components/AIStatusBadge';
import Badge from '../../../../components/Badge';
import { isAmazonCartStockUnverified, stockStatusForDisplay } from '../../../../utils/availability';
import './ProductBadges.css';
import Icon from '../../../../components/Icon';

interface ProductBadgesProps {
  product: Product;
  showAiStatus?: boolean;
  showInStock?: boolean;
  showPriceTypes?: boolean;
}

const ProductBadges: React.FC<ProductBadgesProps> = ({ 
  product, 
  showAiStatus = false,
  showInStock = false,
  showPriceTypes = true
}) => {
  const stockStatus = stockStatusForDisplay(product);
  const isOutOfStock = stockStatus === 'out_of_stock';
  const isPreOrder = stockStatus === 'pre_order';
  const isInStock = stockStatus === 'in_stock';
  const isMemberOnly = stockStatus === 'member_only';
  const isNotAvailable = stockStatus === 'not_available';
  const stockUnverified = isAmazonCartStockUnverified(product);
  
  const currentPrice = typeof product.current_price === 'string' 
    ? parseFloat(product.current_price) 
    : (product.current_price || 0);
  
  const showPriceBadges = !stockUnverified && !isOutOfStock && !isNotAvailable;
  const isHistoricalLow = showPriceBadges && currentPrice > 0 && product.min_price && currentPrice <= product.min_price;
  const isSale = showPriceBadges && product.original_price && product.original_price > currentPrice;

  return (
    <div className="pg-badges">
      {/* Paused Badge */}
      {product.checking_paused && (
        <Badge variant="warning" size="small" icon={<Icon name="pause" />}>
          Paused
        </Badge>
      )}
      
      {/* Sale Badge */}
      {isSale && (
        <Badge variant="deal" size="small">Sale</Badge>
      )}
      
      {/* Price Type Badges */}
      {showPriceTypes && showPriceBadges && product.price_type === 'member-price' && (
        <Badge variant="member" size="small">Member</Badge>
      )}
      {showPriceTypes && showPriceBadges && product.price_type === 'deal-price' && (
        <Badge variant="deal" size="small">Deal</Badge>
      )}
      
      {/* Historical Low Badge */}
      {isHistoricalLow && (
        <Badge variant="success" size="small">Low</Badge>
      )}

      {/* Stock Status Badges */}
      {stockUnverified && (
        <Badge variant="outline" size="small">Stock unverified</Badge>
      )}
      {isPreOrder && (
        <Badge variant="warning" size="small" icon={<Icon name="clock" />}>
          Pre-Order
        </Badge>
      )}
      {isMemberOnly && (
        <Badge variant="member" size="small" icon={<Icon name="user" />}>
          Member Only
        </Badge>
      )}
      {isOutOfStock && (
        <Badge variant="danger" size="small" icon={<Icon name="alertTriangle" />}>
          Out of Stock
        </Badge>
      )}
      {isNotAvailable && (
        <Badge variant="outline" size="small" icon={<Icon name="ban" />}>
          Unavailable
        </Badge>
      )}
      {showInStock && isInStock && (
        <Badge variant="success" size="small" icon={<Icon name="check" />}>
          In Stock
        </Badge>
      )}

      {/* Optional AI Status */}
      {showAiStatus && (
        <AIStatusBadge status={product.ai_status} size="small" />
      )}
    </div>
  );
};

export default ProductBadges;
