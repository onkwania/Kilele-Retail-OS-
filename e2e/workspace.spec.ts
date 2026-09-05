import { test, expect, type Page, type Browser } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const json = async (page: Page, path: string) => {
  const result = await page.evaluate(async (path) => {
    const response = await fetch('/api' + path, { credentials: 'same-origin' });
    return { ok: response.ok, data: await response.json() };
  }, path);
  expect(result.ok, `${path}: ${JSON.stringify(result.data)}`).toBeTruthy();
  return result.data;
};
const ready = async (page: Page, path: string, title: string) => {
  await page.goto(path);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
};
const stock = async (page: Page, id: string) =>
  (await json(page, '/products')).products.find((p: any) => p.id === id);
const dialog = (page: Page) => page.getByRole('dialog');
const openRegister = async (page: Page, name: string, cash: string) => {
  await ready(page, '/pos', 'Point of sale');
  await page.getByRole('button', { name: 'Open register to sell' }).click();
  await dialog(page)
    .getByLabel(/^Register name/)
    .fill(name);
  await dialog(page).getByLabel('Opening cash counted', { exact: true }).fill(cash);
  await dialog(page).getByRole('button', { name: 'Open register', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
};
const scan = async (page: Page, sku: string, qty = 1) => {
  const input = page.getByPlaceholder('Scan barcode, or search product / SKU…');
  for (let i = 0; i < qty; i++) {
    await input.fill(sku);
    await input.press('Enter');
  }
  await expect(page.getByRole('button', { name: 'Take payment', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Take payment', exact: true }).click();
};
const confirmCash = async (page: Page, tender: string) => {
  await dialog(page).getByLabel('Cash tendered', { exact: true }).fill(tender);
  await dialog(page).getByLabel('I have counted the cash and/or verified all electronic payments.').check();
  await dialog(page)
    .getByRole('button', { name: /Complete sale/ })
    .click();
};
const priceReview = async (page: Page, reason: string) => {
  await page.getByRole('button', { name: 'Review & save' }).click();
  await dialog(page)
    .getByLabel(/Reason/i)
    .fill(reason);
  await dialog(page).getByRole('button', { name: 'Save price changes' }).click();
  await expect(dialog(page)).toHaveCount(0);
};
const reviewerLogin = async (browser: Browser) => {
  const context = await browser.newContext({
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1440, height: 1050 },
  });
  const page = await context.newPage();
  await page.addInitScript(() => sessionStorage.setItem('kilele-signed-out', '1'));
  await page.goto('/');
  await page.getByLabel('Email address', { exact: false }).fill('qa.reviewer@example.test');
  await page.getByLabel(/^Password/).fill('qa-temporary-password-2026');
  await page.getByRole('button', { name: /Sign in/ }).click();
  await expect(page.getByRole('heading', { name: 'Make this account yours.' })).toBeVisible();
  await page.getByLabel(/^Current \/ temporary password/).fill('qa-temporary-password-2026');
  await page.getByLabel(/^New password/).fill('qa-rotated-private-passphrase');
  await page.getByLabel(/^Confirm new password/).fill('qa-rotated-private-passphrase');
  await page.getByRole('button', { name: 'Update password' }).click();
  await expect(page.getByRole('heading', { name: 'Business overview', exact: true })).toBeVisible();
  return { context, page };
};

test('real operational journey: manual prices, POS, payments, receiving, expense, closing and independent corrections', async ({
  page,
  browser,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await ready(page, '/', 'Business overview');
  const initial = (await json(page, '/products')).products;
  expect(initial.length).toBeGreaterThan(130);
  expect(
    initial.every(
      (p: any) =>
        p.selling_cents === null && p.cost_cents === null && p.stock === 0 && p.tax_mode === 'unset',
    ),
  ).toBe(true);
  const p = initial.find((p: any) => p.name === 'Coca-Cola Original' && p.size === '500ml'),
    second = initial.find((p: any) => p.name === 'Fanta Orange' && p.size === '350ml');
  expect(p).toBeTruthy();
  // Prices are explicitly entered by the test operator in the UI, never seeded or supplied by the product model.
  await ready(page, '/pricing', 'The price sheet');
  await page.getByPlaceholder('Find a product or SKU…').fill(p.sku);
  await page.getByLabel(`${p.sku} cost`, { exact: true }).fill('100');
  await page.getByLabel(`${p.sku} selling`, { exact: true }).fill('150');
  await page.getByLabel(`${p.sku} tax treatment`).selectOption('none');
  await priceReview(page, 'Synthetic acceptance prices, not market or starter prices');
  expect((await stock(page, p.id)).selling_cents).toBe(15000);
  await ready(page, '/inventory', 'Inventory & stock');
  await page.getByRole('button', { name: 'Opening stock', exact: true }).click();
  await dialog(page)
    .getByLabel(/^Product/)
    .selectOption(p.id);
  await dialog(page)
    .getByLabel(/^Quantity in units/)
    .fill('20');
  await dialog(page)
    .getByLabel(/Reason/)
    .fill('Synthetic opening count of twenty sealed units');
  await dialog(page).getByRole('button', { name: 'Post opening stock' }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect((await stock(page, p.id)).stock).toBe(20);
  await openRegister(page, 'Acceptance main register', '1000');
  await scan(page, p.sku, 2);
  await confirmCash(page, '500');
  await expect(dialog(page).getByRole('heading', { name: 'Sale completed', exact: true })).toBeVisible();
  const receiptDownload = page.waitForEvent('download');
  await dialog(page).getByRole('button', { name: 'Download PDF' }).click();
  const receipt = await receiptDownload;
  await receipt.saveAs(testInfo.outputPath('receipt.pdf'));
  expect((await readFile(testInfo.outputPath('receipt.pdf'))).subarray(0, 5).toString()).toBe('%PDF-');
  await dialog(page).getByRole('button', { name: 'Next customer' }).click();
  expect((await stock(page, p.id)).stock).toBe(18);
  // Genuine split tender, with a unique reference. The software does not claim to initiate M-Pesa.
  await scan(page, p.sku);
  await dialog(page).getByRole('button', { name: 'Split payment', exact: true }).click();
  await dialog(page).getByLabel('Payment 1 amount', { exact: true }).fill('50');
  await dialog(page).getByLabel('Payment 2 amount', { exact: true }).fill('100');
  await dialog(page)
    .getByLabel(/^Transaction reference/)
    .fill('E2E-MPESA-REF-001');
  await dialog(page).getByLabel('I have counted the cash and/or verified all electronic payments.').check();
  await dialog(page)
    .getByRole('button', { name: /Complete sale/ })
    .click();
  await expect(dialog(page).getByRole('heading', { name: 'Sale completed', exact: true })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Next customer' }).click();
  expect((await stock(page, p.id)).stock).toBe(17);
  // Commit the request, drop its response, then reload. Recovery must open the existing receipt, not post again.
  await scan(page, p.sku);
  await page.route('**/api/sales', async (route) => {
    if (route.request().method() === 'POST') {
      const cookie = (await page.context().cookies()).find((c) => c.name === 'kilele_session')!;
      const response = await fetch(route.request().url(), {
        method: 'POST',
        headers: { ...(await route.request().allHeaders()), cookie: `kilele_session=${cookie.value}` },
        body: route.request().postData(),
      });
      expect(response.status).toBe(201);
      await route.abort('failed');
    } else await route.continue();
  });
  await confirmCash(page, '150');
  await expect(page.getByText(/Connection lost before final confirmation/).first()).toBeVisible();
  await page.unroute('**/api/sales');
  await page.reload();
  await page.getByRole('button', { name: 'Resolve saved checkout' }).click();
  await dialog(page).getByRole('button', { name: 'Open saved receipt' }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Sale completed', exact: true })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Next customer' }).click();
  expect((await json(page, '/sales')).sales).toHaveLength(3);
  expect((await stock(page, p.id)).stock).toBe(16);
  // Immutable expense, with a private supporting image.
  await ready(page, '/expenses', 'Business expenses');
  await page.getByRole('button', { name: 'Record expense', exact: true }).click();
  await dialog(page)
    .getByLabel(/^Expense category/)
    .selectOption('Transport');
  await dialog(page).getByLabel('Expense amount', { exact: true }).fill('50');
  await dialog(page)
    .getByLabel(/^Description/)
    .fill('Synthetic delivery transport receipt');
  await dialog(page)
    .locator('input[type=file]')
    .setInputFiles({
      name: 'test-support.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKxkAAAAASUVORK5CYII=',
        'base64',
      ),
    });
  await expect(dialog(page).getByText('Document attached', { exact: true })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Post expense', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect((await json(page, '/expenses')).expenses[0].amount_cents).toBe(5000);
  // Supplier master, credit receiving and a separate cash settlement.
  await ready(page, '/purchases', 'Purchases & suppliers');
  await page.getByRole('button', { name: 'Add supplier', exact: true }).click();
  await dialog(page)
    .getByLabel(/^Supplier name/)
    .fill('Synthetic acceptance supplier');
  await dialog(page)
    .getByLabel(/^Reason/)
    .fill('Create isolated acceptance supplier record');
  await dialog(page).getByRole('button', { name: 'Save supplier' }).click();
  await expect(dialog(page)).toHaveCount(0);
  const supplier = (await json(page, '/suppliers')).suppliers[0];
  await page.getByRole('button', { name: 'Receive stock', exact: true }).first().click();
  await dialog(page)
    .getByLabel(/^Supplier\s*\*/)
    .selectOption(supplier.id);
  await dialog(page)
    .getByLabel(/^Supplier invoice/)
    .fill('E2E-INVOICE-001');
  await dialog(page).getByLabel('Purchase product', { exact: true }).selectOption(p.id);
  await dialog(page).getByLabel('Purchase quantity', { exact: true }).fill('5');
  await dialog(page).getByLabel('Purchase unit cost', { exact: true }).fill('100');
  await dialog(page)
    .getByLabel(/^Receiving reason/)
    .fill('Five units verified against synthetic delivery');
  await dialog(page).getByRole('button', { name: 'Post purchase & receive stock' }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect((await stock(page, p.id)).stock).toBe(21);
  const purchase = (await json(page, '/purchases')).purchases[0];
  await page.locator('tr').filter({ hasText: purchase.ref }).click();
  await dialog(page).getByRole('button', { name: 'Record supplier payment', exact: true }).click();
  await dialog(page).getByLabel('Supplier payment amount', { exact: true }).fill('100');
  await dialog(page)
    .getByLabel(/^Payment method/)
    .selectOption('Cash');
  await dialog(page)
    .getByLabel(/^Payment reference/)
    .fill('E2E-SUPPLIER-CASH-001');
  await dialog(page).getByRole('button', { name: 'Record payment', exact: true }).click();
  await expect(dialog(page).getByText('E2E-SUPPLIER-CASH-001', { exact: true })).toBeVisible();
  if (await page.getByRole('dialog').count())
    await page.getByRole('dialog').getByRole('button', { name: 'Close dialog' }).click();
  // Bulk import stages two manually supplied prices; it must not revalue stock or past sales.
  await ready(page, '/pricing', 'The price sheet');
  await page.getByRole('button', { name: 'Load CSV' }).click();
  await dialog(page)
    .getByLabel(/^Or paste CSV/)
    .fill(
      `SKU,BuyingPrice,SellingPrice,WholesalePrice,PromotionalPrice,TaxMode,TaxPercent\n${p.sku},110,170,160,,none,0\n${second.sku},120,190,,,none,0`,
    );
  await dialog(page).getByRole('button', { name: 'Load for review' }).click();
  expect((await stock(page, p.id)).selling_cents).toBe(15000);
  await priceReview(page, 'Second synthetic manual price batch for history assertions');
  expect((await stock(page, p.id)).selling_cents).toBe(17000);
  expect((await stock(page, p.id)).stock_value_cents).toBe(210000);
  // Create a second administrator through the real staff workflow, with mandatory password rotation.
  await ready(page, '/staff', 'Staff & access');
  await page.getByRole('button', { name: 'Add team member' }).click();
  await dialog(page)
    .getByLabel(/^Full name/)
    .fill('Acceptance Reviewer');
  await dialog(page)
    .getByLabel(/^Email address/)
    .fill('qa.reviewer@example.test');
  await dialog(page).getByLabel(/^Role/).selectOption('admin');
  await dialog(page)
    .getByLabel(/^Temporary password/)
    .fill('qa-temporary-password-2026');
  await dialog(page)
    .getByLabel(/^Reason for access/)
    .fill('Independent review in isolated acceptance test');
  await dialog(page).getByRole('button', { name: 'Create staff account' }).click();
  await expect(dialog(page)).toHaveCount(0);
  // A count request preserves stock until independent approval.
  await ready(page, '/inventory', 'Inventory & stock');
  await page.getByRole('button', { name: 'Stock count', exact: true }).click();
  await dialog(page)
    .getByLabel(/^Product/)
    .selectOption(p.id);
  await dialog(page)
    .getByLabel(/^Actual units counted/)
    .fill('20');
  await dialog(page)
    .getByLabel(/Reason/)
    .fill('Synthetic physical count differs by one unit');
  await dialog(page)
    .getByLabel(/[Ee]xplanation/)
    .fill('The test count is twenty units; please review the difference');
  await dialog(page)
    .getByRole('button', { name: /Submit/ })
    .click();
  await expect(dialog(page)).toHaveCount(0);
  expect((await stock(page, p.id)).stock).toBe(21);
  const sales = (await json(page, '/sales')).sales;
  const original = sales.find((s: any) => s.total_cents === 30000);
  expect(original).toBeTruthy();
  await ready(page, '/sales', 'Sales & transactions');
  await page.locator('tr').filter({ hasText: original.ref }).click();
  await dialog(page).getByRole('button', { name: 'Request correction' }).click();
  await dialog(page)
    .getByLabel(/^Reason for request/)
    .fill('Synthetic full return of the first cash sale');
  await dialog(page)
    .getByLabel(/^Explanation/)
    .fill('Two test units were returned and the original sale was inspected');
  await dialog(page)
    .getByLabel(/^Requested correction/)
    .fill('Reverse the original charged amount and restore two test units');
  await dialog(page).getByRole('button', { name: 'Submit request' }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect((await stock(page, p.id)).stock).toBe(21);
  const requests = (await json(page, '/approvals')).requests;
  const countReq = requests.find((r: any) => r.kind === 'stock_count'),
    saleReq = requests.find((r: any) => r.kind === 'sale_void');
  await page.goto('/approvals?id=' + saleReq.id);
  await expect(dialog(page).getByText(/You submitted this request/)).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'Approve & post' })).toHaveCount(0);
  await dialog(page).getByRole('button', { name: 'Close dialog' }).click();
  // Daily expected cash includes the actual supplier outflow, and the frozen closing is immutable.
  await ready(page, '/reconciliation', 'Daily closing');
  const before = (await json(page, '/sessions')).current;
  expect(before.expected_cents).toBe(135000);
  await page.getByLabel('Actual cash counted', { exact: true }).fill('1350');
  await page.getByLabel(/^Closing note/).fill('Test drawer counted and balanced before independent review');
  await page.getByRole('button', { name: 'Close & submit reconciliation' }).click();
  await dialog(page).getByRole('button', { name: 'Confirm & close register' }).click();
  await expect(dialog(page)).toHaveCount(0);
  const closing = (await json(page, '/sessions')).closings[0];
  expect(closing.expected_cents).toBe(135000);
  const reviewer = await reviewerLogin(browser);
  reviewer.page.on('pageerror', (e) => errors.push(e.message));
  await openRegister(reviewer.page, 'Acceptance review register', '500');
  for (const requestId of [countReq.id, saleReq.id, closing.request_id]) {
    await reviewer.page.goto('/approvals?id=' + requestId);
    await dialog(reviewer.page)
      .getByLabel(/^Review \/ decision reason/)
      .fill('Independent inspection completed in the isolated acceptance test');
    await dialog(reviewer.page)
      .getByRole('button', {
        name: requestId === closing.request_id ? 'Approve closing' : 'Approve & post',
        exact: true,
      })
      .click();
    await expect(dialog(reviewer.page)).toHaveCount(0);
  }
  const returned = await stock(reviewer.page, p.id);
  expect(returned.stock).toBe(22);
  expect(returned.stock_value_cents).toBe(220000);
  const frozen = (await json(reviewer.page, '/sessions')).closings.find((r: any) => r.id === closing.id);
  expect(frozen.expected_cents).toBe(135000);
  expect(frozen.actual_cents).toBe(135000);
  expect(frozen.status).toBe('approved');
  expect((await json(reviewer.page, '/sessions')).current.expected_cents).toBe(20000);
  const saleDetail = await json(reviewer.page, '/sales/' + original.id);
  expect(saleDetail.sale.total_cents).toBe(30000);
  expect(saleDetail.items[0].unit_price_cents).toBe(15000);
  expect(saleDetail.reversals).toHaveLength(1);
  const report = await json(reviewer.page, '/reports/profit');
  expect(report.totals.revenue_cents).toBe(30000);
  expect(report.totals.cogs_cents).toBe(20000);
  expect(report.totals.profit_cents).toBe(10000);
  const dashboard = await json(reviewer.page, '/dashboard');
  expect(dashboard.summary.operating_cents).toBe(-5000);
  await ready(reviewer.page, '/reports?type=profit', 'Reports & insights');
  await expect(reviewer.page.getByRole('button', { name: 'CSV', exact: true })).toBeEnabled();
  const csvDownload = reviewer.page.waitForEvent('download');
  await reviewer.page.getByRole('button', { name: 'CSV', exact: true }).click();
  const csv = await csvDownload;
  await csv.saveAs(testInfo.outputPath('profit.csv'));
  expect(await readFile(testInfo.outputPath('profit.csv'), 'utf8')).toContain('Coca-Cola Original');
  const pdfDownload = reviewer.page.waitForEvent('download');
  await reviewer.page.getByRole('button', { name: 'PDF', exact: true }).click();
  await (await pdfDownload).saveAs(testInfo.outputPath('profit.pdf'));
  expect((await readFile(testInfo.outputPath('profit.pdf'))).subarray(0, 5).toString()).toBe('%PDF-');
  expect((await json(reviewer.page, '/integrity')).ok).toBe(true);
  expect(errors).toEqual([]);
  await reviewer.context.close();
});

test('workspace navigation, tablet POS and mobile administration render without page errors or horizontal overflow', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const pages = [
    ['/', 'Business overview'],
    ['/products', 'Product catalogue'],
    ['/pos', 'Point of sale'],
    ['/sales', 'Sales & transactions'],
    ['/inventory', 'Inventory & stock'],
    ['/purchases', 'Purchases & suppliers'],
    ['/expenses', 'Business expenses'],
    ['/reconciliation', 'Daily closing'],
    ['/approvals', 'Approval centre'],
    ['/reports', 'Reports & insights'],
    ['/staff', 'Staff & access'],
    ['/audit', 'Audit trail'],
    ['/settings', 'Business settings'],
  ];
  for (const [path, title] of pages) {
    await ready(page, path, title);
    await expect(page.locator('.loading-state')).toHaveCount(0);
  }
  await page.setViewportSize({ width: 1024, height: 768 });
  await ready(page, '/pos', 'Point of sale');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [path, title] of [
    ['/', 'Business overview'],
    ['/approvals', 'Approval centre'],
    ['/settings', 'Business settings'],
    ['/reports', 'Reports & insights'],
  ]) {
    await ready(page, path, title);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), path).toBe(true);
  }
  expect(errors).toEqual([]);
});

test('embedded preview authentication works with secure partitioned cookies', async ({ browser }) => {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1050 },
  });
  const page = await context.newPage();
  await page.goto('https://localhost:4174/__acceptance/embed');
  const frame = page.frameLocator('iframe');
  await expect(frame.getByRole('heading', { name: 'Business overview', exact: true })).toBeVisible();
  await frame.getByRole('link', { name: 'Products', exact: true }).click();
  await expect(frame.getByRole('heading', { name: 'Product catalogue', exact: true })).toBeVisible();
  await expect(frame.getByText('Price not set').first()).toBeVisible();
  const cookie = (await context.cookies()).find(
    (c) => c.name === 'kilele_session' && c.domain === '127.0.0.1',
  );
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.secure).toBe(true);
  expect(cookie?.sameSite).toBe('None');
  expect(cookie?.partitionKey).toBeTruthy();
  await frame.getByRole('link', { name: 'Sales', exact: true }).click();
  await frame.locator('tbody tr').first().click();
  const pdfDownload = page.waitForEvent('download');
  await frame.getByRole('button', { name: 'Print / view receipt' }).click();
  expect((await pdfDownload).suggestedFilename()).toMatch(/\.pdf$/);
  await frame.getByRole('button', { name: 'Close dialog' }).click();
  await frame.getByRole('link', { name: 'Expenses', exact: true }).click();
  await frame.locator('tbody tr').first().click();
  const evidenceDownload = page.waitForEvent('download');
  await frame.getByRole('link', { name: 'View supporting receipt' }).click();
  expect((await evidenceDownload).suggestedFilename()).toBe('test-support.png');
  await context.close();
});

test('cashier can sell configured products without cost access, admin controls or wholesale discounts', async ({
  page,
  browser,
}) => {
  await ready(page, '/staff', 'Staff & access');
  await page.getByRole('button', { name: 'Add team member' }).click();
  await dialog(page)
    .getByLabel(/^Full name/)
    .fill('Acceptance Cashier');
  await dialog(page)
    .getByLabel(/^Email address/)
    .fill('qa.cashier@example.test');
  await dialog(page).getByLabel(/^Role/).selectOption('cashier');
  await dialog(page)
    .getByLabel(/^Temporary password/)
    .fill('qa-cashier-temporary-2026');
  await dialog(page)
    .getByLabel(/^Reason for access/)
    .fill('Verify restricted cashier workflow in acceptance');
  await dialog(page).getByRole('button', { name: 'Create staff account' }).click();
  await expect(dialog(page)).toHaveCount(0);
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4173' }),
    cashier = await context.newPage();
  await cashier.addInitScript(() => sessionStorage.setItem('kilele-signed-out', '1'));
  await cashier.goto('/');
  await cashier.getByLabel(/^Email address/).fill('qa.cashier@example.test');
  await cashier.getByLabel(/^Password/).fill('qa-cashier-temporary-2026');
  await cashier.getByRole('button', { name: /Sign in/ }).click();
  await cashier.getByLabel(/^Current \/ temporary password/).fill('qa-cashier-temporary-2026');
  await cashier.getByLabel(/^New password/).fill('qa-cashier-rotated-passphrase');
  await cashier.getByLabel(/^Confirm new password/).fill('qa-cashier-rotated-passphrase');
  await cashier.getByRole('button', { name: 'Update password' }).click();
  await expect(cashier.getByRole('heading', { name: 'Point of sale', exact: true })).toBeVisible();
  await expect(cashier.getByRole('link', { name: 'Staff & access', exact: true })).toHaveCount(0);
  await expect(cashier.getByRole('link', { name: 'Audit trail', exact: true })).toHaveCount(0);
  const products = (await json(cashier, '/products')).products,
    product = products.find((p: any) => p.name === 'Coca-Cola Original' && p.size === '500ml');
  expect(product.cost_configured).toBe(1);
  expect(product).not.toHaveProperty('cost_cents');
  expect(product).not.toHaveProperty('stock_value_cents');
  await openRegister(cashier, 'Acceptance restricted cashier', '0');
  await scan(cashier, product.sku);
  await confirmCash(cashier, '200');
  await expect(dialog(cashier).getByRole('heading', { name: 'Sale completed', exact: true })).toBeVisible();
  await dialog(cashier).getByRole('button', { name: 'Next customer' }).click();
  const sales = (await json(cashier, '/sales')).sales;
  expect(sales).toHaveLength(1);
  expect(sales[0].total_cents).toBe(17000);
  expect(sales[0]).not.toHaveProperty('cogs_cents');
  await ready(cashier, '/approvals', 'My requests');
  await cashier.goto('/settings');
  await expect(cashier.getByText(/Your role does not have access/)).toBeVisible();
  expect((await json(page, '/integrity')).ok).toBe(true);
  await context.close();
});

test('production-mode HTTPS requires real login, disables preview and issues a strict secure session', async ({
  browser,
}) => {
  const context = await browser.newContext({ baseURL: 'https://127.0.0.1:4175', ignoreHTTPSErrors: true }),
    page = await context.newPage();
  const response = await page.goto('/');
  expect(response?.headers()['x-frame-options']).toBe('DENY');
  await expect(page.getByRole('heading', { name: 'Good to have you here.' })).toBeVisible();
  await expect(page.getByRole('button', { name: /preview/i })).toHaveCount(0);
  const before = await page.evaluate(async () => {
    const r = await fetch('/api/products');
    return r.status;
  });
  expect(before).toBe(401);
  await page.getByLabel(/^Email address/).fill('production-test@example.test');
  await page.getByLabel(/^Password/).fill('production-mode-test-only-password');
  await page.getByRole('button', { name: /Sign in/ }).click();
  await expect(page.getByRole('heading', { name: 'Business overview', exact: true })).toBeVisible();
  const me = await json(page, '/auth/me');
  expect(me.preview).toBe(false);
  const cookie = (await context.cookies()).find((c) => c.name === 'kilele_session');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.secure).toBe(true);
  expect(cookie?.sameSite).toBe('Strict');
  const previewStatus = await page.evaluate(
    async (csrf) =>
      (await fetch('/api/auth/preview', { method: 'POST', headers: { 'X-CSRF-Token': csrf } })).status,
    me.csrf,
  );
  expect(previewStatus).toBe(404);
  expect(
    (await json(page, '/products')).products.every((p: any) => p.selling_cents === null && p.stock === 0),
  ).toBe(true);
  await context.close();
});
