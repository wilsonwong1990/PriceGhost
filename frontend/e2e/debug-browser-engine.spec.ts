import { expect, test } from '@playwright/test';

test('saves the selected browser override and omits it when overrides are disabled', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('token', 'acceptance-token');
    localStorage.setItem('user', JSON.stringify({ id: 1, name: 'Admin', is_admin: true }));
  });
  const saves: Record<string, unknown>[] = [];
  let acquisition: { mode: 'browser' | 'http' | 'bypass'; browserEngine?: string } = { mode: 'browser', browserEngine: 'chromium' };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/admin/retailers' && route.request().method() === 'POST') {
      const saved = route.request().postDataJSON();
      saves.push(saved);
      await route.fulfill({ json: saved });
      return;
    }
    if (path === '/api/admin/debug/extract') {
      await route.fulfill({ json: { retailerName: 'Example', name: 'Product', stockStatus: 'in_stock', priceCandidates: [], acquisition } });
      return;
    }
    const responses: Record<string, unknown> = {
      '/api/admin/debug/status': { enabled: true },
      '/api/admin/settings': {},
    };
    await route.fulfill({ json: responses[path] ?? {} });
  });

  await page.goto('/admin/debug');
  await page.getByPlaceholder('Enter URL to analyze...').fill('https://example.test/product');
  await page.getByText('Enable Config Overrides').click();
  await page.getByText('Browser Scraper', { exact: true }).click();
  await page.getByRole('button', { name: 'RUN EXTRACTION' }).click();
  await page.getByRole('button', { name: 'SAVE', exact: true }).click();
  await expect.poll(() => saves[0]?.browser_engine).toBe('chromium');

  // Changing the engine without rerunning must not relabel the Chromium result.
  await page.locator('#debug-browser-engine').selectOption('firefox');
  await page.getByRole('button', { name: 'SAVE', exact: true }).click();
  await expect.poll(() => saves.length).toBe(2);
  expect(saves[1]?.browser_engine).toBe('chromium');

  acquisition = { mode: 'browser', browserEngine: 'firefox' };
  await page.getByRole('button', { name: 'RUN EXTRACTION' }).click();
  await page.getByRole('button', { name: 'SAVE', exact: true }).click();
  await expect.poll(() => saves[2]?.browser_engine).toBe('firefox');

  acquisition = { mode: 'http' };
  await page.getByText('Browser Scraper', { exact: true }).click();
  await page.getByRole('button', { name: 'RUN EXTRACTION' }).click();
  await page.getByRole('button', { name: 'SAVE', exact: true }).click();
  await expect.poll(() => saves.length).toBe(4);
  expect(saves[3]).not.toHaveProperty('browser_engine');

  acquisition = { mode: 'bypass' };
  await page.getByText('Browser Scraper', { exact: true }).click();
  await page.getByText('Enable Config Overrides').click();
  await page.getByRole('button', { name: 'RUN EXTRACTION' }).click();
  await page.getByRole('button', { name: 'SAVE', exact: true }).click();
  await expect.poll(() => saves.length).toBe(5);
  expect(saves[4]).not.toHaveProperty('browser_engine');
  expect(saves[4]).not.toHaveProperty('use_browser_scraper');

  // The backend can use a saved retailer engine even with overrides disabled.
  acquisition = { mode: 'browser', browserEngine: 'firefox' };
  await page.getByRole('button', { name: 'RUN EXTRACTION' }).click();
  await page.getByRole('button', { name: 'SAVE', exact: true }).click();
  await expect.poll(() => saves[5]?.browser_engine).toBe('firefox');
  expect(saves[5]?.use_browser_scraper).toBe(true);

  acquisition = { mode: 'browser' };
  await page.getByRole('button', { name: 'RUN EXTRACTION' }).click();
  await page.getByRole('button', { name: 'SAVE', exact: true }).click();
  await expect.poll(() => saves.length).toBe(7);
  expect(saves[6]).not.toHaveProperty('browser_engine');

  await page.getByPlaceholder('Enter URL to analyze...').fill('https://other.test/product');
  await page.getByRole('button', { name: 'SAVE', exact: true }).click();
  await expect(page.getByText('Run extraction again before saving a different URL')).toBeVisible();
  expect(saves).toHaveLength(7);
});
