import React from 'react';
import { useQuery } from '@tanstack/react-query';
import LoadingSpinner from '../../../../components/LoadingSpinner';
import StockTimeline from '../../components/StockTimeline';
import StockHistoryList from '../../components/StockHistoryList';
import { stockHistoryQuery } from '../../../../api/queries';

interface StockAvailabilitySectionProps {
  productId: number;
  currentStockUnverified?: boolean;
}

const StockAvailabilitySection: React.FC<StockAvailabilitySectionProps> = ({ productId, currentStockUnverified = false }) => {
  const stockQuery = useQuery(stockHistoryQuery(productId, 30));
  const allHistory = stockQuery.data?.history ?? [];
  const history = currentStockUnverified ? allHistory.filter(entry => entry.id !== 0) : allHistory;
  const stats = stockQuery.data?.stats ?? null;

  if (stockQuery.isLoading) {
    return (
      <div className="stock-timeline-loading" style={{ display: 'flex', justifyContent: 'center', padding: '3rem 0' }}>
        <LoadingSpinner centered />
      </div>
    );
  }

  if (stockQuery.isError) {
    return (
      <div className="alert alert-error">
        Failed to load stock history. <button className="btn btn-secondary btn-sm" onClick={() => void stockQuery.refetch()}>Retry</button>
      </div>
    );
  }

  if ((!stats && !currentStockUnverified) || history.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
        No stock history recorded yet.
      </div>
    );
  }

  return (
    <div className="stock-availability-section">
      {currentStockUnverified ? (
        <p>Current stock is unverified. Availability estimates are unavailable; earlier stock recordings are shown below.</p>
      ) : stats && (
        <StockTimeline history={history} stats={stats} days={30} />
      )}
      <StockHistoryList history={history} />
    </div>
  );
};

export default StockAvailabilitySection;
