import { MigrationContext } from '../config/migrate';

/**
 * Per-retailer browser engine for the Browser Scraper.
 *
 * Every browser scrape ran on headless Chromium. Some bot managers wall
 * headless Chromium outright but may let headless Firefox through, so a
 * retailer can now opt in to Firefox:
 *
 *   chromium  the existing engine, with the stealth and adblock plugins
 *   firefox   Firefox ESR driven over WebDriver BiDi
 *
 * The column defaults to 'chromium', so every existing retailer keeps the
 * engine it has today. The CHECK constraint is declared with the column, so
 * `ADD COLUMN IF NOT EXISTS` keeps the whole migration idempotent, and dropping
 * the column drops the constraint with it.
 */
export const up = async ({ context: pool }: { context: MigrationContext }) => {
  await pool.query(`
    ALTER TABLE public.retailer_configs
    ADD COLUMN IF NOT EXISTS browser_engine varchar(16) NOT NULL DEFAULT 'chromium'
      CHECK (browser_engine IN ('chromium', 'firefox'));
  `);
};

export const down = async ({ context: pool }: { context: MigrationContext }) => {
  await pool.query(`
    ALTER TABLE public.retailer_configs
    DROP COLUMN IF EXISTS browser_engine;
  `);
};
