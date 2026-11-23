import { expect, test } from '@playwright/test';

test('saves the selected browser override and omits it when overrides are disabled', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('token', 'acceptance-token');
    localStorage.setItem('user', JSON.stringify({ id: 1, name: 'Admin', is_admin: true }));
  });
  const saves: Record<string, unknown>[] = [];
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/admin/retailers' && route.request().method() === 'POST') {
      const saved = route.request().postDataJSON();
      saves.push(saved);
      await route.fulfill({ json: saved });
      return;
    }
    const responses: Record<string, unknown> = {
      '/api/admin/debug/status': { enabled: true },
      '/api/admin/settings': {},
      '/api/admin/debug/extract': { retailerName: 'Example', name: 'Product', stockStatus: 'in_stock', priceCandidates: [] },
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

  await page.getByRole('button', { name: 'RUN EXTRACTION' }).click();
  await page.getByRole('button', { name: 'SAVE', exact: true }).click();
  await expect.poll(() => saves[2]?.browser_engine).toBe('firefox');

  await page.getByText('Browser Scraper', { exact: true }).click();
  await page.getByRole('button', { name: 'RUN EXTRACTION' }).click();
  await page.getByRole('button', { name: 'SAVE', exact: true }).click();
  await expect.poll(() => saves.length).toBe(4);
  expect(saves[3]).not.toHaveProperty('browser_engine');

  await page.getByText('Browser Scraper', { exact: true }).click();
  await page.getByText('Enable Config Overrides').click();
  await page.getByRole('button', { name: 'RUN EXTRACTION' }).click();
  await page.getByRole('button', { name: 'SAVE', exact: true }).click();
  await expect.poll(() => saves.length).toBe(5);
  expect(saves[4]).not.toHaveProperty('browser_engine');
  expect(saves[4]).not.toHaveProperty('use_browser_scraper');
});
