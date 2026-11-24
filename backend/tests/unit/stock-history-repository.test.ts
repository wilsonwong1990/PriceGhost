import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('../../src/config/database', () => ({ default: { query } }));

import { stockHistoryRepository } from '../../src/services/domain/product/repositories/stock-history.repository';

describe('stock history period backfill', () => {
  beforeEach(() => {
    query.mockReset();
  });

  it('retains the original recording date when carrying a status into the period', async () => {
    const recordedAt = new Date(Date.now() - 60 * 86400000);
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [{ id: 12, product_id: 7, status: 'in_stock', changed_at: recordedAt }],
    });

    const history = await stockHistoryRepository.getByProductId(7, 30);

    expect(history).toHaveLength(1);
    expect(history[0].recorded_at).toEqual(recordedAt);
    expect(history[0].changed_at.getTime()).toBeGreaterThan(recordedAt.getTime());
  });
});
