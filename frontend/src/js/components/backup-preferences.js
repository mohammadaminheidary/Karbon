const dashboardKey = "karbon-dashboard-layout-v1:admin";

export function readBackupPreferences() {
  const appearance = window.KarbonAppearance;
  let savedLayout;
  try {
    savedLayout = JSON.parse(localStorage.getItem(dashboardKey));
  } catch { /* The dashboard also falls back to its default layout. */ }
  const layouts = {};
  if (savedLayout?.version === 1) {
    for (const mode of ["desktop", "tablet", "mobile"]) {
      const items = savedLayout.layouts?.[mode];
      if (Array.isArray(items) && items.length <= 64 && items.every((item) =>
        typeof item?.id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(item.id)
        && [item.x, item.y, item.w, item.h].every(Number.isSafeInteger)
      )) {
        layouts[mode] = items.map(({ id, x, y, w, h }) => ({ id, x, y, w, h }));
      }
    }
  }
  return {
    appearance: appearance?.getPreferences() ?? null,
    dashboard_layout: Object.keys(layouts).length ? { version: 1, layouts } : null,
  };
}

export function applyBackupPreferences(preferences) {
  const appearanceKey = window.KarbonAppearance.STORAGE_KEY;
  for (const [key, value] of [[appearanceKey, preferences.appearance], [dashboardKey, preferences.dashboard_layout]]) {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  }
}
