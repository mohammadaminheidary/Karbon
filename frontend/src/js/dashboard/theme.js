// SVG presentation attributes and legend styles resolve CSS tokens themselves.
// This also follows theme changes without synchronously forcing page layout.
export function dashboardPalette() {
  const token = (name, fallback) => `var(${name}, ${fallback})`;
  return {
    primary: token("--dash-blue", "#1e40af"),
    strong: token("--dash-blue-strong", "#1e3a8a"),
    secondary: token("--dash-blue-mid", "#3b82f6"),
    soft: token("--dash-blue-soft", "#93c5fd"),
    light: token("--dash-blue-light", "#dbeafe"),
    tint: token("--dash-blue-tint", "#eff6ff"),
    border: token("--dash-border", "#e2e8f0"),
    muted: token("--dash-blue-light", "#dbeafe"),
  };
}
