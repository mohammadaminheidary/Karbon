// Integer grid geometry, independent of DOM and pointer input.
export const ROW_HEIGHT = 24;
export const GAP = 16;
export const ROW_UNIT = ROW_HEIGHT + GAP;
export const cloneLayout = (items) => items.map((item) => ({ ...item }));
export const overlaps = (a, b) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
export function limits(definition, columns) {
  return {
    minW: definition.kind === "kpi" ? 2 : columns === 4 ? 4 : 3,
    minH: definition.kind === "chart" ? 8 : 3,
  };
}
export function normalize(item, definition, columns) {
  const { minW, minH } = limits(definition, columns);
  const integer = (value, fallback) =>
    Number.isSafeInteger(value) ? value : fallback;
  const w = Math.min(columns, Math.max(minW, integer(item.w, columns)));
  return {
    id: definition.id,
    w,
    h: Math.max(minH, Math.min(30, integer(item.h, definition.h))),
    x: Math.max(0, Math.min(columns - w, integer(item.x, 0))),
    y: Math.max(0, Math.min(500, integer(item.y, 0))),
  };
}
export function resolveLayout(items, definitions, columns, priority) {
  const normalized = definitions.map((def) =>
    normalize(items.find((item) => item.id === def.id) || def, def, columns),
  );
  const moving = normalized.find((item) => item.id === priority);
  const order = normalized
    .filter((item) => item !== moving)
    .sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
  const placed = moving ? [moving] : [];
  for (const item of order) {
    let collisions;
    while (
      (collisions = placed.filter((other) => overlaps(item, other))).length
    ) {
      item.y = Math.max(...collisions.map((other) => other.y + other.h));
    }
    placed.push(item);
  }
  return definitions.map((def) => placed.find((item) => item.id === def.id));
}
export function defaultLayout(definitions, columns) {
  const items = [];
  for (const definition of definitions) {
    const w =
      columns === 12
        ? definition.w
        : definition.w >= 8
          ? columns
          : definition.kind === "kpi"
            ? 2
            : 4;
    const item = normalize(
      { ...definition, w, x: 0, y: 0 },
      definition,
      columns,
    );
    search: for (let y = 0; ; y++) {
      for (let x = 0; x <= columns - item.w; x++) {
        Object.assign(item, { x, y });
        if (!items.some((other) => overlaps(item, other))) break search;
      }
    }
    items.push(item);
  }
  return items;
}
export function restoreLayout(value, definitions, columns) {
  if (
    !Array.isArray(value) ||
    value.length !== definitions.length ||
    new Set(value.map((item) => item?.id)).size !== definitions.length ||
    !definitions.every((def) =>
      value.some(
        (item) =>
          item?.id === def.id &&
          [item.x, item.y, item.w, item.h].every(Number.isSafeInteger),
      ),
    )
  )
    return defaultLayout(definitions, columns);
  return resolveLayout(value, definitions, columns);
}
