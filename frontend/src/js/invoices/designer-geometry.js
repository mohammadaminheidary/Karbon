import { clamp, snapNumber } from "./designer-fields.js";

export function fitElement(element, bounds) {
  const w = snapNumber(clamp(element.w, 2, bounds.w));
  const h = snapNumber(clamp(element.h, 2, bounds.h));
  return { ...element, w, h, x: snapNumber(clamp(element.x, 0, bounds.w - w)),
    y: snapNumber(clamp(element.y, 0, bounds.h - h)) };
}

export function resizeElement(element, handle, dx, dy, bounds, lock) {
  const angle = element.rotation * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const horizontal = handle.includes("e") ? 1 : handle.includes("w") ? -1 : 0;
  const vertical = handle.includes("s") ? 1 : handle.includes("n") ? -1 : 0;
  let w = Math.max(2, element.w + horizontal * (cos * dx + sin * dy));
  let h = Math.max(2, element.h + vertical * (-sin * dx + cos * dy));
  if (lock || element.aspect) {
    const sx = w / element.w;
    const sy = h / element.h;
    const factor = !vertical || (horizontal && Math.abs(sx - 1) > Math.abs(sy - 1)) ? sx : sy;
    const scale = clamp(factor, Math.max(2 / element.w, 2 / element.h), Math.min(bounds.w / element.w, bounds.h / element.h));
    w = element.w * scale;
    h = element.h * scale;
  }
  const localX = horizontal * (w - element.w) / 2;
  const localY = vertical * (h - element.h) / 2;
  return fitElement({
    ...element, w, h,
    x: element.x + (element.w - w) / 2 + cos * localX - sin * localY,
    y: element.y + (element.h - h) / 2 + sin * localX + cos * localY,
  }, bounds);
}

function snappedAxis(value, length, size, points, limit, grid) {
  const options = [];
  const target = (start, line) => options.push({ value: start, line, distance: Math.abs(start - value) });
  const sorted = [...points].sort((a, b) => a.start - b.start);
  for (const position of [0, size / 2, size, ...sorted.flatMap(({ start, end }) => [start, (start + end) / 2, end])]) {
    for (const offset of [0, length / 2, length]) target(position - offset, position);
  }
  const before = sorted.filter(({ end }) => end <= value + limit).at(-1);
  const after = sorted.find(({ start }) => start >= value + length - limit);
  if (before && after && after.start - before.end >= length) {
    target((before.end + after.start - length) / 2, (before.end + after.start) / 2);
  }
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    const gap = b.start - a.end;
    if (gap < 0) continue;
    target(b.end + gap, b.end + gap);
    target(a.start - gap - length, a.start - gap);
  }
  if (grid) target(Math.round(value / 5) * 5);
  return options.filter((option) => option.value >= 0 && option.value + length <= size + 0.01)
    .sort((a, b) => a.distance - b.distance).find((option) => option.distance <= limit)
    || { value };
}

export function moveElements(elements, active, primary, dx, dy, bounds, { snap, grid, tolerance }) {
  const others = elements.filter((element) => element.visible && !active.some(({ id }) => id === element.id));
  if (snap) {
    const x = snappedAxis(primary.x + dx, primary.w, bounds.w, others.map(({ x, w }) => ({ start: x, end: x + w })), tolerance, grid);
    const y = snappedAxis(primary.y + dy, primary.h, bounds.h, others.map(({ y, h }) => ({ start: y, end: y + h })), tolerance, grid);
    dx = x.value - primary.x;
    dy = y.value - primary.y;
    return shifted(dx, dy, x.line, y.line);
  }
  return shifted(dx, dy);

  function shifted(x, y, vertical, horizontal) {
    const mx = clamp(x, -Math.min(...active.map((e) => e.x)), bounds.w - Math.max(...active.map((e) => e.x + e.w)));
    const my = clamp(y, -Math.min(...active.map((e) => e.y)), bounds.h - Math.max(...active.map((e) => e.y + e.h)));
    return {
      items: active.map((e) => ({ ...e, x: snapNumber(e.x + mx), y: snapNumber(e.y + my) })),
      vertical: mx === x ? vertical : undefined, horizontal: my === y ? horizontal : undefined,
    };
  }
}
