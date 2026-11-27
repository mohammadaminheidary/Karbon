import { node } from "../finance/finance-utils.js";
import { button, changePage, field, pageFields, propertyFields, tableFields, clamp } from "./designer-fields.js";
import { fitElement, moveElements, resizeElement } from "./designer-geometry.js";
import {
  beginPrint, designBounds, ELEMENT_GROUPS, elementLabel, makeElement, makePaper, mm,
  PX_PER_MM, renderInvoicePages, renderScaledPages, applyElementStyle,
} from "./invoice-paper.js";

const handles = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const copy = (value) => structuredClone(value);

export function mountInvoiceDesigner(template, { previewInvoice, onSave, onExit, draftKey, editable }) {
  let layout = copy(template.layout);
  let name = template.name;
  let revision = template.revision;
  let selected = new Set();
  let primaryId = null;
  let undo = [], redo = [];
  let clipboard = [];
  let zoom = 1, grid = false, guides = true, rulers = true, hand = false, space = false;
  let layersVisible = true, preview = false;
  let saveTimer, inFlight, dirty = false, saveBlocked = false, pointer = null, previewVersion = 0, disconnectPreview;
  let paper, canvasContent, selectionBox, floating, paperRuler, lines = [];
  let boxes = new Map();
  const focusBeforeClose = document.activeElement;
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(draftKey)); } catch { /* Storage is optional. */ }

  const dialog = node("dialog", "invoice-designer");
  dialog.dir = "rtl";
  dialog.setAttribute("aria-labelledby", "invoiceDesignerTitle");
  const heading = node("header", "designer-heading");
  const title = node("h2", "", "طراح بصری فاکتور");
  title.id = "invoiceDesignerTitle";
  const status = node("p", "designer-status", "ذخیره شده");
  status.setAttribute("role", "status");
  const toolbar = node("div", "designer-toolbar");
  toolbar.setAttribute("aria-label", "ابزارهای طراحی");
  const workspace = node("div", "designer-workspace");
  const left = node("aside", "designer-sidebar designer-library scrollbar-right");
  const right = node("aside", "designer-sidebar designer-inspector scrollbar-right");
  const properties = node("section", "designer-properties");
  const layers = node("section", "designer-layers scrollbar-right");
  const viewport = node("main", "designer-viewport");
  viewport.tabIndex = 0;
  viewport.dir = "ltr";
  viewport.setAttribute("aria-label", "بوم فاکتور");
  const stage = node("div", "designer-stage");
  const surface = node("div", "designer-surface");
  const previewHost = node("div", "designer-preview");
  previewHost.hidden = true;
  const zoomLabel = node("output", "designer-zoom");
  const previewButton = button("پیش‌نمایش", togglePreview, { pressed: false });
  const undoButton = button("↶", () => historyStep(undo, redo), { title: "واگرد" });
  const redoButton = button("↷", () => historyStep(redo, undo), { title: "انجام دوباره" });
  const saveButton = button("ذخیره", () => save(), { primary: true });
  const printButton = button("چاپ / PDF", () => {
    if (previewPapers.length) beginPrint(previewPapers, layout.page);
  });
  printButton.hidden = true;
  let previewPapers = [];

  heading.append(title, status, button("خروج", close), saveButton);
  stage.append(surface);
  viewport.append(stage, previewHost);
  right.append(layers, properties);
  workspace.append(left, viewport, right);
  dialog.append(heading, toolbar, workspace);
  document.body.append(dialog);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    const openMenu = floating?.querySelector(".designer-element-menu:not([hidden])");
    if (openMenu) { floating.querySelector("button").click(); return; }
    close();
  });

  function toggle(current, set, label) {
    const control = button(label, () => {
      set(!current());
      control.setAttribute("aria-pressed", String(current()));
    }, { pressed: current() });
    return control;
  }
  toolbar.append(undoButton, redoButton, button("−", () => setZoom(zoom / 1.2), { title: "کوچک‌نمایی" }), zoomLabel,
    button("+", () => setZoom(zoom * 1.2), { title: "بزرگ‌نمایی" }), button("اندازه صفحه", fit, { title: "جا دادن صفحه در دید" }),
    toggle(() => grid, (next) => { grid = next; renderCanvas(); }, "شبکه"),
    toggle(() => guides, (next) => { guides = next; }, "راهنماها"),
    toggle(() => rulers, (next) => { rulers = next; renderCanvas(); }, "خط‌کش"),
    toggle(() => hand, (next) => { hand = next; viewport.classList.toggle("designer-pan", hand); }, "جابجایی نما"),
    toggle(() => layersVisible, (next) => { layersVisible = next; layers.hidden = !next; }, "لایه‌ها"));

  const editTools = node("div", "designer-toolbar-edit");
  const alignMenu = node("details", "designer-add-menu");
  const addShapes = node("details", "designer-add-menu");
  alignMenu.append(node("summary", "", "تراز"));
  for (const [label, axis, edge] of [["چپ", "x", 0], ["مرکز افقی", "x", .5], ["راست", "x", 1],
    ["بالا", "y", 0], ["مرکز عمودی", "y", .5], ["پایین", "y", 1]]) {
    alignMenu.append(button(label, () => { alignSelected(axis, edge); alignMenu.open = false; }));
  }
  addShapes.append(node("summary", "", "شکل"));
  for (const type of ELEMENT_GROUPS.at(-1)[1]) {
    addShapes.append(button(elementLabel(type), () => { add(type); addShapes.open = false; }));
  }
  editTools.append(alignMenu, button("کپی", copySelection), button("جایگذاری", paste),
    button("تکثیر", () => { copySelection(); paste(); }), button("حذف", remove),
    button("+ متن", () => add("text")), addShapes);
  toolbar.append(editTools, previewButton, printButton);
  editTools.hidden = !editable;
  saveButton.hidden = !editable;
  if (draft?.layout?.version === 1 && Array.isArray(draft.layout.elements) && draft.layout.page && draft.layout.table?.columns
      && draft.revision >= 1 && editable) {
    const recover = button("بازیابی پیش‌نویس", () => {
      if (draft.revision !== revision && !window.confirm("پیش‌نویس از نسخه قدیمی‌تری است. در صورت ذخیره، نسخه فعلی جایگزین خواهد شد. ادامه می‌دهید؟")) return;
      if (draft.name) name = draft.name;
      commit(draft.layout);
      recover.remove();
    });
    heading.insertBefore(recover, saveButton);
  }

  left.append(node("h3", "", "افزودن عنصر"));
  for (const [label, types] of ELEMENT_GROUPS) {
    const group = node("details", "designer-library-group");
    group.open = true;
    group.append(node("summary", "", label));
    for (const type of types) {
      const action = button(elementLabel(type), () => add(type));
      action.disabled = !editable;
      group.append(action);
    }
    left.append(group);
  }
  left.append(node("p", "designer-hint", "برای چند انتخاب، Shift را نگه دارید. برای جابجایی نما، فاصله را نگه دارید."));
  function current() { return layout.elements.find(({ id }) => id === primaryId); }
  function live() { return previewInvoice(layout); }
  function canEdit() { return editable && !preview; }
  function select(id, extend = false, group = true) {
    const element = layout.elements.find((item) => item.id === id);
    const ids = element?.group && group && !extend
      ? layout.elements.filter((item) => item.group === element.group).map((item) => item.id)
      : element ? [element.id] : [];
    if (!extend) selected = new Set(ids);
    else for (const key of ids) {
      if (selected.has(key)) selected.delete(key);
      else selected.add(key);
    }
    primaryId = selected.has(id) ? id : [...selected].at(-1) ?? null;
    renderSelection();
    renderSidebars();
  }

  function updated() {
    dirty = true;
    saveBlocked = false;
    status.textContent = "در انتظار ذخیره…";
    try { localStorage.setItem(draftKey, JSON.stringify({ revision, name, layout })); } catch { /* Manual save still works. */ }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 800);
    render();
  }
  const editorState = () => ({ layout, selected: [...selected], primaryId });
  function commit(next) {
    undo.push(editorState());
    if (undo.length > 60) undo.shift();
    redo = [];
    layout = next;
    updated();
  }
  function historyStep(from, to) {
    if (!canEdit() || !from.length) return;
    to.push(editorState());
    const state = from.pop();
    layout = state.layout;
    selected = new Set(state.selected);
    primaryId = state.primaryId;
    updated();
  }
  async function save() {
    clearTimeout(saveTimer);
    if (inFlight) {
      await inFlight;
      if (dirty && !saveBlocked) return save();
      return !dirty;
    }
    if (!dirty) return true;
    const sent = layout;
    status.textContent = "در حال ذخیره…";
    inFlight = (async () => {
      try {
        const result = await onSave({ revision, name, layout: sent });
        revision = result.revision;
        dirty = sent !== layout;
        saveBlocked = false;
        status.textContent = dirty ? "در انتظار ذخیره…" : "ذخیره شده";
        try {
          if (dirty) localStorage.setItem(draftKey, JSON.stringify({ revision, name, layout }));
          else localStorage.removeItem(draftKey);
        } catch { /* Server saved successfully. */ }
      } catch (error) {
        saveBlocked = true;
        status.textContent = error.message;
      }
    })();
    await inFlight;
    inFlight = null;
    if (dirty && !saveBlocked) return save();
    return !dirty;
  }
  async function close() {
    if (!(await save()) && !window.confirm("ذخیره کامل نشد. از طراح خارج می‌شوید؟")) return;
    clearTimeout(saveTimer);
    window.removeEventListener("beforeunload", beforeUnload);
    disconnectPreview?.();
    observer.disconnect();
    dialog.close();
    dialog.remove();
    focusBeforeClose?.focus();
    onExit();
  }
  function beforeUnload(event) {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = true;
  }
  window.addEventListener("beforeunload", beforeUnload);

  function positionStage() {
    const pxWidth = parseFloat(paper.style.width) * PX_PER_MM;
    const pxHeight = parseFloat(paper.style.height) * PX_PER_MM;
    surface.style.width = `${pxWidth * zoom}px`;
    surface.style.height = `${pxHeight * zoom}px`;
    paper.style.transform = `scale(${zoom})`;
    paper.style.setProperty("--handle-scale", String(1 / zoom));
    if (paperRuler) paperRuler.style.setProperty("--ruler-unit", `${10 * PX_PER_MM * zoom}px`);
    zoomLabel.value = `${Math.round(zoom * 100)}%`;
  }
  function setZoom(next) {
    if (!paper || preview) return;
    const cx = (viewport.scrollLeft + viewport.clientWidth / 2 - surface.offsetLeft) / zoom;
    const cy = (viewport.scrollTop + viewport.clientHeight / 2 - surface.offsetTop) / zoom;
    zoom = clamp(next, .18, 3);
    positionStage();
    viewport.scrollTo(surface.offsetLeft + cx * zoom - viewport.clientWidth / 2,
      surface.offsetTop + cy * zoom - viewport.clientHeight / 2);
  }
  function fit() {
    if (!paper || preview) return;
    const width = parseFloat(paper.style.width) * PX_PER_MM;
    const height = parseFloat(paper.style.height) * PX_PER_MM;
    setZoom(Math.min((viewport.clientWidth - 54) / width, (viewport.clientHeight - 54) / height, 1.5));
    viewport.scrollTo(0, 0);
  }

  function renderCanvas() {
    const result = makePaper(layout.page, true);
    paper = result.paper;
    canvasContent = result.content;
    const bounds = designBounds(layout.page);
    canvasContent.style.width = mm(bounds.w);
    canvasContent.style.height = mm(bounds.h);
    paper.classList.add("designer-paper");
    canvasContent.classList.toggle("designer-grid", grid);
    canvasContent.classList.add("designer-paper-content");
    result.footer.textContent = layout.page.footer;
    const invoice = live();
    boxes = new Map();
    for (const [index, element] of layout.elements.entries()) {
      if (!element.visible) continue;
      const box = makeElement(element, invoice, { editing: true, index });
      box.style.height = mm(element.h);
      box.dataset.element = element.id;
      box.classList.toggle("designer-locked", element.locked || !editable);
      canvasContent.append(box);
      boxes.set(element.id, box);
    }
    paperRuler = rulers ? node("div", "designer-rulers") : null;
    if (paperRuler) {
      for (const [axis, size] of [["x", result.width], ["y", result.height]]) {
        const ruler = node("div", `designer-ruler designer-ruler-${axis}`);
        for (let tick = 0; tick < size; tick += 10) {
          const mark = node("span", "", String(tick));
          mark.style[axis === "x" ? "left" : "top"] = `${tick / size * 100}%`;
          ruler.append(mark);
        }
        paperRuler.append(ruler);
      }
    }
    surface.replaceChildren(...[paper, paperRuler].filter(Boolean));
    positionStage();
    renderSelection();
  }

  function placeOutline(outline, element) {
    Object.assign(outline.style, { left: mm(element.x), top: mm(element.y), width: mm(element.w),
      height: mm(element.h), transform: element.rotation ? `rotate(${element.rotation}deg)` : "" });
  }
  function renderSelection() {
    canvasContent.querySelectorAll(".designer-outline, .designer-floating").forEach((item) => item.remove());
    selectionBox = null;
    floating = null;
    for (const id of selected) {
      const element = layout.elements.find((item) => item.id === id);
      if (!element?.visible) continue;
      const outline = node("div", "designer-outline");
      outline.classList.toggle("designer-outline-muted", element.locked || id !== primaryId);
      placeOutline(outline, element);
      canvasContent.append(outline);
      if (id !== primaryId) continue;
      selectionBox = outline;
      if (!element.locked && editable) for (const position of handles) {
        const handle = node("span", `designer-handle designer-handle-${position}`);
        handle.dataset.handle = position;
        outline.append(handle);
      }
      floating = node("div", "designer-floating");
      const more = button("⋯", () => {
        const open = menu.hidden;
        menu.hidden = !open;
        more.setAttribute("aria-expanded", String(open));
      }, { title: "عملیات عنصر" });
      more.setAttribute("aria-expanded", "false");
      const menu = node("div", "designer-element-menu scrollbar-right");
      menu.hidden = true;
      menu.append(button("ویژگی‌ها", () => {
        menu.hidden = true;
        more.setAttribute("aria-expanded", "false");
        properties.scrollIntoView({ block: "nearest" });
        properties.querySelector("input")?.focus();
      }));
      if (editable) {
        for (const [label, action] of [
          ["تکثیر", () => { copySelection(); paste(); }], ["کپی", copySelection], ["جایگذاری", paste],
          ["یک لایه جلو", () => reorder(id, 1)], ["یک لایه عقب", () => reorder(id, -1)],
          ["روی همه", () => reorder(id, Infinity)], ["زیر همه", () => reorder(id, -Infinity)],
          [element.locked ? "باز کردن قفل" : "قفل", () => patch(id, { locked: !element.locked }, true)],
          ["پنهان کردن", () => patch(id, { visible: false }, true)], ["حذف", remove],
        ]) menu.append(button(label, () => { menu.hidden = true; more.setAttribute("aria-expanded", "false"); action(); }));
      }
      floating.append(more, menu);
      placeMenu(element);
      canvasContent.append(floating);
    }
  }
  function placeMenu(element) {
    floating.style.left = mm(clamp(element.x + element.w, 12, designBounds(layout.page).w - 1));
    floating.style.top = mm(element.y >= 12 ? element.y - 3 : element.y + Math.min(element.h, 10) + 5);
  }
  function renderSidebars() {
    const element = current();
    properties.replaceChildren(node("h3", "", element ? "ویژگی‌های عنصر" : "ویژگی‌های صفحه"));
    layers.replaceChildren(node("h3", "", "لایه‌ها"));
    if (selected.size > 1 && editable) {
      layers.append(button("گروه‌بندی", () => setGroup(crypto.randomUUID())));
    }
    if (element?.group && editable) layers.append(button("لغو گروه", () => setGroup(null)));
    for (const item of [...layout.elements].reverse()) {
      const row = node("div", "designer-layer");
      row.classList.toggle("designer-layer-active", selected.has(item.id));
      const choose = button(item.name || elementLabel(item.type), (event) => select(item.id, event.shiftKey, !event.altKey));
      choose.classList.add("designer-layer-label");
      choose.setAttribute("aria-pressed", String(selected.has(item.id)));
      const visible = button(item.visible ? "◉" : "○", () => patch(item.id, { visible: !item.visible }, true),
        { title: item.visible ? "پنهان کردن لایه" : "نمایش لایه" });
      const lock = button(item.locked ? "🔒" : "🔓", () => patch(item.id, { locked: !item.locked }, true),
        { title: item.locked ? "باز کردن قفل لایه" : "قفل کردن لایه" });
      visible.disabled = lock.disabled = !editable;
      row.draggable = editable;
      row.addEventListener("dragstart", (event) => event.dataTransfer.setData("text/plain", item.id));
      row.addEventListener("dragover", (event) => event.preventDefault());
      row.addEventListener("drop", (event) => {
        event.preventDefault();
        const id = event.dataTransfer.getData("text/plain");
        if (!id || id === item.id) return;
        const old = layout.elements.findIndex((layer) => layer.id === id);
        const to = layout.elements.findIndex((layer) => layer.id === item.id);
        if (old >= 0) reorder(id, to - old);
      });
      row.append(choose, visible, lock);
      layers.append(row);
    }
    if (!element) {
      properties.append(pageFields(layout.page, (key, value) => commit(changePage(layout, key, value))));
    } else {
      properties.append(field("نام لایه", element.name, (value) => patch(element.id, { name: value }, true), { max: 180 }));
      properties.append(propertyFields(element, layout, (key, value) => {
        const values = { [key]: key === "weight" ? Number(value) : value };
        if (element.aspect && ["w", "h"].includes(key)) {
          const bounds = designBounds(layout.page);
          const ratio = clamp(value / element[key], Math.max(2 / element.w, 2 / element.h),
            Math.min(bounds.w / element.w, bounds.h / element.h));
          values.w = element.w * ratio;
          values.h = element.h * ratio;
        }
        patch(element.id, values);
      }));
      if (element.type === "table") {
        properties.append(node("h3", "", "جدول اقلام"), tableFields(layout.table, (table) => commit({ ...layout, table })));
      }
      const commands = node("div", "designer-button-row");
      commands.append(button("↑ جلو", () => reorder(element.id, 1)), button("↓ عقب", () => reorder(element.id, -1)),
        button("حذف لایه", remove));
      properties.append(commands);
      if (element.type === "table" && element.locked) properties.querySelectorAll(".designer-property-groups:last-of-type input, .designer-property-groups:last-of-type select, .designer-property-groups:last-of-type button")
        .forEach((control) => { control.disabled = true; });
    }
    if (!editable) properties.querySelectorAll("input, select, textarea, button").forEach((control) => { control.disabled = true; });
  }

  function render() {
    const ids = new Set(layout.elements.map(({ id }) => id));
    selected = new Set([...selected].filter((id) => ids.has(id)));
    if (!selected.has(primaryId)) primaryId = [...selected].at(-1) ?? null;
    undoButton.disabled = !undo.length || !canEdit();
    redoButton.disabled = !redo.length || !canEdit();
    renderCanvas();
    renderSidebars();
  }

  function patch(id, values, force = false) {
    if (!canEdit()) return;
    const item = layout.elements.find((element) => element.id === id);
    if (!item || (!force && item.locked)) return;
    const next = fitElement({ ...item, ...values }, designBounds(layout.page));
    commit({ ...layout, elements: layout.elements.map((element) => element.id === id ? next : element) });
  }
  function setGroup(group) {
    if (!canEdit()) return;
    const currentGroup = current()?.group;
    commit({ ...layout, elements: layout.elements.map((element) => !element.locked &&
      (group ? selected.has(element.id) : element.group === currentGroup) ? { ...element, group } : element) });
  }
  function add(type) {
    if (!canEdit() || layout.elements.length >= 100) return;
    if (type === "table") {
      const existing = layout.elements.find((element) => element.type === type);
      if (existing) { select(existing.id); return; }
    }
    const bounds = designBounds(layout.page);
    const shape = ["hline", "vline", "rectangle", "ellipse"].includes(type);
    const w = type === "table" ? bounds.w : type === "vline" ? 2 : 50;
    const h = type === "hline" ? 2 : shape ? 20 : type === "table" ? 20 : 14;
    const hovered = current();
    const id = crypto.randomUUID();
    const element = fitElement({
      id, type, name: elementLabel(type), text: type === "text" ? "متن دلخواه" : "",
      x: hovered ? hovered.x + 5 : bounds.w / 2 - w / 2,
      y: hovered ? hovered.y + 5 : bounds.h / 2 - h / 2, w, h,
      rotation: 0, aspect: false, locked: false, visible: true, group: null, font: "Vazirmatn", font_size: 11,
      weight: 400, color: "#17253a", align: "right", line_height: 1.5, spacing: 0,
      background: shape ? "#d8e2ef" : "transparent", border: "#cbd5e1", border_width: 0, radius: 0, opacity: 1, padding: 0,
    }, bounds);
    selected = new Set([id]);
    primaryId = id;
    commit({ ...layout, elements: [...layout.elements, element] });
  }
  function reorder(id, delta) {
    if (!canEdit()) return;
    const elements = [...layout.elements];
    const index = elements.findIndex((element) => element.id === id);
    if (index < 0 || elements[index].locked) return;
    const target = clamp(index + delta, 0, elements.length - 1);
    if (index === target) return;
    const [item] = elements.splice(index, 1);
    elements.splice(target, 0, item);
    commit({ ...layout, elements });
  }
  function remove() {
    if (!canEdit()) return;
    const elements = layout.elements.filter((element) => element.locked || !selected.has(element.id));
    if (elements.length !== layout.elements.length) commit({ ...layout, elements });
  }
  function copySelection() {
    if (selected.size) clipboard = copy(layout.elements.filter((element) => selected.has(element.id) && element.type !== "table"));
  }
  function paste() {
    if (!canEdit() || !clipboard.length) return;
    const ids = new Map();
    const items = clipboard.slice(0, 100 - layout.elements.length).map((element) => {
      if (element.group && !ids.has(element.group)) ids.set(element.group, crypto.randomUUID());
      return fitElement({ ...element, id: crypto.randomUUID(), group: ids.get(element.group) ?? null,
        locked: false, x: element.x + 4, y: element.y + 4 }, designBounds(layout.page));
    });
    if (!items.length) return;
    selected = new Set(items.map(({ id }) => id));
    primaryId = items.at(-1).id;
    commit({ ...layout, elements: [...layout.elements, ...items] });
  }
  function alignSelected(axis, edge) {
    if (!canEdit() || !selected.size) return;
    const bounds = designBounds(layout.page);
    const size = axis === "x" ? "w" : "h";
    const items = layout.elements.filter((item) => selected.has(item.id));
    const start = items.length === 1 ? 0 : Math.min(...items.map((item) => item[axis]));
    const end = items.length === 1 ? bounds[size] : Math.max(...items.map((item) => item[axis] + item[size]));
    commit({ ...layout, elements: layout.elements.map((item) => selected.has(item.id) && !item.locked
      ? fitElement({ ...item, [axis]: start + (end - start - item[size]) * edge }, bounds) : item) });
  }

  function moveGuides(vertical, horizontal) {
    for (const guide of lines) guide.remove();
    lines = [];
    for (const [axis, value] of [["x", vertical], ["y", horizontal]]) {
      if (value == null || !guides) continue;
      const line = node("span", `designer-guide designer-guide-${axis}`);
      line.style[axis === "x" ? "left" : "top"] = mm(value);
      canvasContent.append(line);
      lines.push(line);
    }
  }
  viewport.addEventListener("pointerdown", (event) => {
    if (preview || event.target.closest("button, .designer-element-menu")) return;
    if (hand || space || event.button === 1) {
      event.preventDefault();
      pointer = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop, pan: true };
    } else if (event.button === 0) {
      const handle = event.target.closest("[data-handle]")?.dataset.handle;
      const hit = event.target.closest("[data-element]")?.dataset.element;
      if (!handle && hit) {
        if (hit !== primaryId || event.shiftKey) select(hit, event.shiftKey);
        if (event.shiftKey) return;
      } else if (!handle) { select(null); return; }
      const item = current();
      if (!item || item.locked || !editable) return;
      event.preventDefault();
      const active = layout.elements.filter((element) => selected.has(element.id) && !element.locked);
      pointer = { x: event.clientX, y: event.clientY, handle, item, active, next: [] };
    } else return;
    viewport.focus({ preventScroll: true });
    viewport.setPointerCapture(event.pointerId);
  });
  viewport.addEventListener("pointermove", (event) => {
    if (!pointer) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    if (pointer.pan) {
      viewport.scrollTo(pointer.left - dx, pointer.top - dy);
      return;
    }
    if (!pointer.next.length && Math.hypot(dx, dy) < 2) return;
    const factor = PX_PER_MM * zoom;
    const bounds = designBounds(layout.page);
    const move = pointer.handle
      ? { items: [resizeElement(pointer.item, pointer.handle, dx / factor, dy / factor, bounds, event.shiftKey)] }
      : moveElements(layout.elements, pointer.active, pointer.item, dx / factor, dy / factor, bounds,
        { snap: guides && !event.altKey, grid, tolerance: 6 / factor });
    pointer.next = move.items;
    moveGuides(move.vertical, move.horizontal);
    for (const element of move.items) {
      const box = boxes.get(element.id);
      if (box) {
        applyElementStyle(box, element);
        box.style.height = mm(element.h);
      }
      if (element.id === primaryId && selectionBox) {
        placeOutline(selectionBox, element);
        if (floating) placeMenu(element);
      }
    }
  });
  viewport.addEventListener("pointerup", () => {
    const next = pointer?.next;
    pointer = null;
    moveGuides();
    if (!next?.length) return;
    const positions = new Map(next.map((element) => [element.id, element]));
    commit({ ...layout, elements: layout.elements.map((element) => positions.get(element.id) || element) });
  });
  viewport.addEventListener("pointercancel", () => { pointer = null; renderCanvas(); });
  dialog.addEventListener("keyup", (event) => { if (event.code === "Space") space = false; });
  window.addEventListener("blur", () => { space = false; }, { signal: (() => {
    const controller = new AbortController();
    dialog.addEventListener("close", () => controller.abort(), { once: true });
    return controller.signal;
  })() });
  dialog.addEventListener("keydown", (event) => {
    if (event.target.closest("input, textarea, select, [contenteditable]") || preview) return;
    const key = event.key.toLowerCase();
    const shortcut = event.ctrlKey || event.metaKey;
    const actions = { z: () => event.shiftKey ? historyStep(redo, undo) : historyStep(undo, redo),
      c: copySelection, v: paste, d: () => { copySelection(); paste(); } };
    if (shortcut && actions[key] && (key !== "c" || selected.size)) {
      event.preventDefault();
      actions[key]();
      return;
    }
    if (event.code === "Space" && event.target === viewport) {
      event.preventDefault();
      space = true;
      return;
    }
    if (!canEdit() || !selected.size || shortcut) return;
    if (key === "delete" || key === "backspace") { event.preventDefault(); remove(); }
    const direction = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] }[key];
    if (!direction) return;
    const item = current();
    if (item?.locked) return;
    event.preventDefault();
    const step = event.shiftKey ? 5 : 1;
    const movable = layout.elements.filter((element) => selected.has(element.id) && !element.locked);
    const result = moveElements(layout.elements, movable, item, direction[0] * step, direction[1] * step,
      designBounds(layout.page), { snap: false });
    const positions = new Map(result.items.map((element) => [element.id, element]));
    commit({ ...layout, elements: layout.elements.map((element) => positions.get(element.id) || element) });
  });

  async function togglePreview() {
    preview = !preview;
    const version = ++previewVersion;
    previewButton.setAttribute("aria-pressed", String(preview));
    previewButton.textContent = preview ? "بازگشت به ویرایش" : "پیش‌نمایش";
    dialog.classList.toggle("designer-in-preview", preview);
    previewHost.hidden = !preview;
    stage.hidden = preview;
    printButton.hidden = !preview;
    printButton.disabled = true;
    editTools.hidden = preview || !editable;
    disconnectPreview?.();
    if (!preview) { previewPapers = []; return; }
    previewHost.replaceChildren(node("p", "designer-hint", "در حال چیدمان صفحات…"));
    try {
      const papers = await renderInvoicePages(live());
      if (version !== previewVersion) return;
      previewPapers = papers;
      disconnectPreview = renderScaledPages(previewHost, papers);
      printButton.disabled = false;
    } catch (error) {
      if (version === previewVersion) previewHost.replaceChildren(node("p", "designer-hint", error.message));
    }
  }
  const observer = new ResizeObserver(() => {
    if (viewport.clientWidth && zoomLabel.value === "") fit();
  });
  observer.observe(viewport);
  dialog.showModal();
  render();
  fit();
  viewport.focus();
}
