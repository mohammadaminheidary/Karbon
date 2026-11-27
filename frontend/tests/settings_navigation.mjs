export async function clickSettingsSection(page, section) {
  const button = page.locator(`[data-settings-target="${section}"]`);
  const summary = page.locator("#settingsNavigation details:not([open])")
    .filter({ has: button })
    .locator("summary");
  if (await summary.count()) await summary.click();
  await button.click();
}
