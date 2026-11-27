export function waitForPurchaseForm(page) {
  return page.locator("#createOrderModal[open] #orderPay:enabled").waitFor();
}

export const purchaseRow = (page, index = 0) =>
  page.locator("#orderItems .orders-item-row").nth(index);

export async function choosePurchaseCategory(page, categoryId, index = 0) {
  const field = purchaseRow(page, index).locator(".item-product");
  await field.click();
  await page.locator(`[data-category-option="${categoryId}"]`).click();
  return field;
}

export async function selectPurchaseItem(page, categoryId, productId, index = 0) {
  const field = await choosePurchaseCategory(page, categoryId, index);
  await page.locator(`[data-product-option="${productId}"]`).click();
  return field;
}

export async function fillPurchaseRow(page, product, quantity, price, index = 0) {
  await selectPurchaseItem(page, product.warehouse_category_id, product.id, index);
  const row = purchaseRow(page, index);
  await row.locator(".item-quantity").fill(String(quantity));
  await row.locator(".item-price").fill(String(price));
}

export async function advancePurchasePayment(page) {
  await page.locator("#orderPay").click();
  await page.locator("#orderPaymentModal[aria-hidden=false]").waitFor();
}

export async function closePurchaseInvoice(page) {
  const invoice = page.locator("#finalInvoiceModal");
  await invoice.waitFor();
  await invoice.locator("header [data-dialog-close]").click();
  await invoice.waitFor({ state: "hidden" });
}
