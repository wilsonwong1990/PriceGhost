import { useState } from 'react';
import { ProductService } from '../services/ProductService';
import { useToast } from '../../../context/ToastContext';
import { useAsyncAction } from '../../../hooks/useAsyncAction';
import { apiErrorMessage, isApiError } from '../../../api/error';
import { queryClient } from '../../../api/queryClient';
import { queryKeys } from '../../../api/queries';
import { clearUnverifiedCartPrice, invalidateProductHistory, syncProductCaches } from '../../../api/productCache';
import { PriceReviewResponse, Product } from '../../../types/api';

interface UseProductActionsProps {
  onProductDeleted?: (id: number) => void;
  onProductDeleteFailed?: (id: number) => void;
  onProductUpdated?: (id: number, data: any) => void;
  onRefreshUnverified?: (id: number) => void;
}

const isAmazonCartUnavailable = (product: Product) =>
  product.preferred_extraction_method === 'amazon-cart' && Boolean(product.unavailable_reason);

export function useProductActions({ onProductDeleted, onProductDeleteFailed, onProductUpdated, onRefreshUnverified }: UseProductActionsProps = {}) {
  const { showToast } = useToast();
  const { execute: runAction, isLoading } = useAsyncAction();
  
  const [priceReviewData, setPriceReviewData] = useState<PriceReviewResponse | null>(null);
  const [showPriceModal, setShowPriceModal] = useState(false);
  const [activeProductId, setActiveProductId] = useState<number | null>(null);

  const handleRefresh = (id: number, fallbackName?: string | null) => runAction(async () => {
    try {
      await ProductService.refreshPrice(id);
    } catch (error) {
      const body = isApiError(error) && error.body && typeof error.body === 'object'
        ? error.body as { status?: unknown } : null;
      const cartUnverified = body?.status === 'unavailable' || body?.status === 'superseded';
      if (cartUnverified) {
        clearUnverifiedCartPrice(id);
        onRefreshUnverified?.(id);
      }
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.products.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.products.items }),
        queryClient.invalidateQueries({ queryKey: queryKeys.products.detail(id) }),
        invalidateProductHistory(id),
      ]).catch((reloadError: unknown) => showToast('Failed to reload product', 'error', apiErrorMessage(reloadError)));
      if (cartUnverified) {
        void ProductService.getById(id).then((updated) => {
          syncProductCaches(updated);
          onProductUpdated?.(id, updated);
        }).catch((reloadError: unknown) => showToast('Failed to reload product', 'error', apiErrorMessage(reloadError)));
      }
      throw error;
    }
    const updatedProductRes = await ProductService.getById(id);
    syncProductCaches(updatedProductRes);
    if (updatedProductRes.preferred_extraction_method === 'amazon-cart') {
      await queryClient.invalidateQueries({ queryKey: queryKeys.products.items });
    }
    // A refresh records a new price and stock reading, so the cached history has
    // to go before anything reloads it.
    await invalidateProductHistory(id);
    if (onProductUpdated) onProductUpdated(id, updatedProductRes);
    if (isAmazonCartUnavailable(updatedProductRes)) {
      showToast('Amazon cart price could not be verified.', 'error');
    }
    return updatedProductRes;
  }, {
    onSuccessMessage: (res) => {
      if (isAmazonCartUnavailable(res)) return '';
      const name = res?.name || fallbackName;
      return name ? `${name} price refreshed` : `Product #${id} price refreshed`;
    },
    onErrorMessage: 'Failed to refresh price'
  });

  const handleRescan = (id: number, amazonCart = false) => runAction(async () => {
    setActiveProductId(id);
    let res: PriceReviewResponse;
    try {
      res = await ProductService.scan(id, amazonCart);
    } catch (error) {
      const cached = queryClient.getQueryData<Product>(queryKeys.products.detail(id)) ??
        queryClient.getQueryData<Product[]>(queryKeys.products.all)?.find((product) => product.id === id);
      if ((amazonCart || cached?.preferred_extraction_method === 'amazon-cart') &&
          (!isApiError(error) || error.status >= 500)) {
        clearUnverifiedCartPrice(id);
        onRefreshUnverified?.(id);
        void queryClient.invalidateQueries({ queryKey: queryKeys.products.all })
          .catch((reloadError: unknown) => showToast('Failed to reload product', 'error', apiErrorMessage(reloadError)));
        void ProductService.getById(id).then((updated) => {
          syncProductCaches(updated);
          onProductUpdated?.(id, updated);
        }).catch((reloadError: unknown) => showToast('Failed to reload product', 'error', apiErrorMessage(reloadError)));
      }
      throw error;
    }
    if (res.amazonCartRequired) {
      if (amazonCart || !res.priceCandidates.some((candidate) => candidate.method === 'amazon-cart')) {
        clearUnverifiedCartPrice(id);
        onRefreshUnverified?.(id);
      }
      const updatedProduct = await ProductService.getById(id);
      syncProductCaches(updatedProduct);
      await queryClient.invalidateQueries({ queryKey: queryKeys.products.items });
      if (onProductUpdated) onProductUpdated(id, updatedProduct);
    }
    setPriceReviewData(res);
    setShowPriceModal(true);
  }, { onErrorMessage: 'Failed to start re-scan' });

  const handleDelete = (id: number, fallbackName?: string | null) => {
    return runAction(async () => {
      await ProductService.delete(id);
      queryClient.removeQueries({ queryKey: queryKeys.products.detail(id) });
      queryClient.setQueryData<Product[]>(queryKeys.products.all, (products) =>
        products?.filter((product) => product.id !== id) ?? [],
      );
      if (onProductDeleted) onProductDeleted(id);
    }, {
      onSuccessMessage: fallbackName ? `${fallbackName} deleted` : `Product #${id} deleted`,
      onErrorFallback: 'Failed to delete product',
      throwError: true
    }).catch((err) => {
      if (onProductDeleteFailed) onProductDeleteFailed(id);
      throw err;
    });
  };

  const handleTogglePause = (id: number, targetPaused: boolean, fallbackName?: string | null) => runAction(async () => {
    const res = await ProductService.update(id, { checking_paused: targetPaused });
    syncProductCaches(res);
    if (res.preferred_extraction_method === 'amazon-cart') {
      await queryClient.invalidateQueries({ queryKey: queryKeys.products.items });
    }
    if (onProductUpdated) onProductUpdated(id, res);
    return res;
  }, {
    onSuccessMessage: (res) => {
      const name = res?.name || fallbackName;
      if (name) {
        return targetPaused ? `${name} tracking paused` : `${name} tracking resumed`;
      }
      return targetPaused ? `Product #${id} tracking paused` : `Product #${id} tracking resumed`;
    },
    onErrorFallback: 'Failed to toggle pause state'
  });

  const handlePriceSelected = async (selectedPrice: number, selectedMethod: string, selectedCurrency: string, _category: string | null, selector?: string) => {
    if (!priceReviewData || activeProductId === null) return;

    try {
      const res = await ProductService.confirmSelection(activeProductId, {
        selectedPrice,
        selectedMethod,
        selectedCurrency,
        name: priceReviewData.name,
        imageUrl: priceReviewData.imageUrl,
        stockStatus: priceReviewData.stockStatus,
        html: priceReviewData.html,
        selector
      });
      
      syncProductCaches(res);
      // Confirming a candidate writes a price row of its own, same as a refresh.
      await invalidateProductHistory(activeProductId);
      if (onProductUpdated) onProductUpdated(activeProductId, res);
      setShowPriceModal(false);
      setPriceReviewData(null);
      const updatedName = res?.name || priceReviewData.name;
      const successMsg = updatedName
        ? `${updatedName} updated via re-scan`
        : `Product #${activeProductId} updated via re-scan`;
      setActiveProductId(null);
      showToast(successMsg, 'success');
    } catch (err: unknown) {
      if (selectedMethod === 'amazon-cart' && isApiError(err) && err.status === 409) {
        clearUnverifiedCartPrice(activeProductId);
        onRefreshUnverified?.(activeProductId);
        void queryClient.invalidateQueries({ queryKey: queryKeys.products.all })
          .catch((reloadError: unknown) => showToast('Failed to reload product', 'error', apiErrorMessage(reloadError)));
      }
      showToast('Failed to confirm selection', 'error', apiErrorMessage(err));
    }
  };

  const closePriceModal = () => {
    setShowPriceModal(false);
    setPriceReviewData(null);
    setActiveProductId(null);
  };

  return {
    isRefreshing: isLoading,
    handleRefresh,
    handleRescan,
    handleDelete,
    handleTogglePause,
    handlePriceSelected,
    closePriceModal,
    showPriceModal,
    priceReviewData,
    activeProductId
  };
}
