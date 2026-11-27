export async function selectOrderProduct(input, product) {
  await input.fill(product.name);
  await input.page().locator(`[data-product-option="${product.id}"]`).click();
}
