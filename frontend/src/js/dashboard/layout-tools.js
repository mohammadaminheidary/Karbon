// Loaded on the first layout edit; the initial view still restores saved layouts.
import { notifyNavbar } from "../components/navbar-notification.js";
import { number } from "./chart.js";
import {
  GAP,
  ROW_UNIT,
  cloneLayout,
  limits,
  resolveLayout,
} from "./layout-model.js";
export class LayoutTools {
  enter() {
    if (this.editing) return;
    this.beforeEditing = structuredClone(this.layouts);
    this.editing = true;
    this.grid.dataset.editing = "true";
    this.editButton.setAttribute("aria-pressed", "true");
    this.editButton.disabled = true;
    this.actions.hidden = false;
    this.status.textContent =
      "کارت‌ها را از دستگیره بالا جابجا و از گوشه پایین تغییر اندازه دهید. کلیدهای جهت هم در دسترس‌اند. سپس ذخیره کنید.";
    this.contentChanged();
  }
  exit() {
    this.editing = false;
    this.grid.dataset.editing = "false";
    this.editButton.setAttribute("aria-pressed", "false");
    this.editButton.disabled = false;
    this.actions.hidden = true;
    this.apply();
    this.editButton.focus();
  }
  save() {
    this.abortGesture();
    try {
      const layouts = { ...this.saved, ...this.layouts };
      localStorage.setItem(
        this.storageKey,
        JSON.stringify({ version: 1, layouts }),
      );
      this.saved = structuredClone(layouts);
      this.exit();
      this.status.textContent = "";
      notifyNavbar(
        "چیدمان ذخیره شد؛ در بازدید بعدی همین مرورگر و حساب کاربری بازیابی می‌شود.",
      );
    } catch {
      notifyNavbar(
        "ذخیره چیدمان در مرورگر انجام نشد. تغییرات فعلی حفظ شده‌اند؛ دسترسی ذخیره‌سازی مرورگر را بررسی و دوباره تلاش کنید.",
        { role: "alert" },
      );
    }
  }
  cancel() {
    this.abortGesture();
    this.layouts = this.beforeEditing;
    this.breakpoint();
    this.exit();
    this.status.textContent = "";
    notifyNavbar("تغییرات چیدمان لغو شد.");
  }
  constraints(id) {
    const definition = this.definitions.find((def) => def.id === id);
    return {
      ...limits(definition, this.columns),
      minH: Math.max(
        limits(definition, this.columns).minH,
        Number(this.widgets.get(id).dataset.minH || 0),
      ),
    };
  }
  change(id, patch, base = this.layouts[this.mode]) {
    const item = base.find((item) => item.id === id),
      bounds = this.constraints(id);
    const next = { ...item, ...patch };
    next.w = Math.max(bounds.minW, Math.min(this.columns, next.w));
    next.h = Math.max(bounds.minH, Math.min(30, next.h));
    this.layouts[this.mode] = resolveLayout(
      base.map((item) => (item.id === id ? next : item)),
      this.definitions,
      this.columns,
      id,
    );
    this.apply();
  }
  begin(event, id, type) {
    if (!this.editing || event.button !== 0 || this.gesture) return;
    event.preventDefault();
    const item = this.layouts[this.mode].find((item) => item.id === id);
    this.gesture = {
      id,
      type,
      pointer: event.pointerId,
      control: event.currentTarget,
      clientX: event.clientX,
      clientY: event.clientY,
      item: { ...item },
      before: cloneLayout(this.layouts[this.mode]),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    this.widgets.get(id).dataset.active = "true";
    const tick = () => {
      if (!this.gesture) return;
      const y = this.gesture.latestY ?? this.gesture.clientY;
      const bottom = innerHeight - 110;
      const delta = y < 90 ? -16 : y > bottom ? 16 : 0;
      if (delta && this.gesture.latestY !== undefined) {
        scrollBy(0, delta);
        this.updateGesture();
      }
      this.scrollFrame = requestAnimationFrame(tick);
    };
    this.startScrollY = scrollY;
    this.scrollFrame = requestAnimationFrame(tick);
  }
  move(event) {
    if (!this.gesture || event.pointerId !== this.gesture.pointer) return;
    this.gesture.latestX = event.clientX;
    this.gesture.latestY = event.clientY;
    this.updateGesture();
  }
  updateGesture() {
    const gesture = this.gesture;
    const columnUnit = (this.grid.clientWidth + GAP) / this.columns;
    const dx = Math.round(
      (gesture.clientX - (gesture.latestX ?? gesture.clientX)) / columnUnit,
    );
    const dy = Math.round(
      ((gesture.latestY ?? gesture.clientY) -
        gesture.clientY +
        scrollY -
        this.startScrollY) /
        ROW_UNIT,
    );
    const patch =
      gesture.type === "move"
        ? { x: gesture.item.x + dx, y: gesture.item.y + dy }
        : { w: gesture.item.w + dx, h: gesture.item.h + dy };
    this.change(gesture.id, patch, gesture.before);
  }
  finish(event) {
    if (!this.gesture || event.pointerId !== this.gesture.pointer) return;
    const { id, control, pointer } = this.gesture;
    this.gesture = null;
    cancelAnimationFrame(this.scrollFrame);
    if (control.hasPointerCapture(pointer))
      control.releasePointerCapture(pointer);
    delete this.widgets.get(id).dataset.active;
    this.apply();
    this.announce(id);
    this.contentChanged();
  }
  key(event, id, type) {
    if (
      !this.editing ||
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    )
      return;
    event.preventDefault();
    const item = this.layouts[this.mode].find((item) => item.id === id);
    const dx =
      event.key === "ArrowLeft" ? 1 : event.key === "ArrowRight" ? -1 : 0;
    const dy = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    this.change(
      id,
      type === "move"
        ? { x: item.x + dx, y: item.y + dy }
        : { w: item.w + dx, h: item.h + dy },
    );
    this.announce(id);
  }
  announce(id) {
    const item = this.layouts[this.mode].find((item) => item.id === id);
    this.status.textContent = `${this.widgets.get(id).getAttribute("aria-label")}؛ ${number.format(item.w)} ستون × ${number.format(item.h)} ردیف. برای نگهداری تغییرات ذخیره کنید.`;
  }
}
