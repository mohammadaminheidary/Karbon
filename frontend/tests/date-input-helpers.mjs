export function dateParts(page, id) {
  return page.locator(`[data-date-input="${id}"] [data-date-part]`);
}

export async function fillDate(page, id, value) {
  const year = dateParts(page, id).first();
  await year.click();
  await year.evaluate((input, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    input.dispatchEvent(new ClipboardEvent("paste", {
      clipboardData, bubbles: true, cancelable: true,
    }));
  }, value);
}

export async function readDate(page, id) {
  return dateParts(page, id).evaluateAll((fields) =>
    fields.map((field) =>
      field.value.replace(/[۰-۹]/g, (digit) => "۰۱۲۳۴۵۶۷۸۹".indexOf(digit)),
    ).join("/"),
  );
}
