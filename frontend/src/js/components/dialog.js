const stack = [];
const previousInert = new Map();

function syncBackground() {
  const top = stack.at(-1);
  if (!top) {
    previousInert.forEach((value, element) => {
      element.inert =
        element.tagName === "DIALOG" && element.open ? false : value;
    });
    previousInert.clear();
    if (!document.querySelector("dialog[open]"))
      document.body.classList.remove("overflow-hidden");
    return;
  }
  // Native dialogs provide their own top-layer focus and background isolation.
  if (top.root.tagName === "DIALOG") {
    document.body.classList.add("overflow-hidden");
    return;
  }
  for (const element of document.body.children) {
    if (element.tagName === "SCRIPT") continue;
    if (!previousInert.has(element)) previousInert.set(element, element.inert);
    element.inert =
      element !== top.root && !(element.tagName === "DIALOG" && element.open);
  }
  document.body.classList.add("overflow-hidden");
}

export class Dialog {
  constructor(id, { canClose = () => true, onCancel = () => {}, animateNativeClose = false,
    restoreFocus = (previousFocus) => previousFocus } = {}) {
    this.root = document.getElementById(id);
    this.panel = this.root.querySelector(
      '[data-dialog-panel], [role="dialog"], [role="alertdialog"]',
    );
    this.panel.tabIndex = -1;
    this.canClose = canClose;
    this.onCancel = onCancel;
    this.animateNativeClose = animateNativeClose;
    this.restoreFocus = restoreFocus;
    this.root.querySelectorAll("[data-dialog-close]").forEach((button) => {
      button.addEventListener("click", () => this.cancel());
    });
    if (animateNativeClose) this.root.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.cancel();
    });
    this.root.addEventListener("keydown", (event) => {
      if (stack.at(-1) !== this) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.cancel();
      }
      if (event.key !== "Tab") return;
      const controls = [
        ...this.panel.querySelectorAll(
          'button, input, select, textarea, summary, a[href], [tabindex="0"]',
        ),
      ].filter(
        (element) => !element.disabled && element.getClientRects().length,
      );
      if (!controls.length) {
        event.preventDefault();
        this.panel.focus();
        return;
      }
      const first = controls[0],
        last = controls.at(-1);
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === this.panel)
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          document.activeElement === this.panel)
      ) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  open(focusTarget) {
    if (this.closing) return;
    clearTimeout(this.closeTimer);
    if (!stack.includes(this)) {
      this.previousFocus = document.activeElement;
      stack.push(this);
    }
    this.root.classList.remove("hidden");
    this.root.classList.add("flex");
    this.root.setAttribute("aria-hidden", "false");
    if (this.root.tagName === "DIALOG") {
      this.root.inert = false;
      if (!this.root.open) this.root.showModal();
    }
    syncBackground();
    requestAnimationFrame(() => {
      if (this.closing || !stack.includes(this)) return;
      this.panel.classList.remove("scale-95", "opacity-0");
      this.panel.classList.add("scale-100", "opacity-100");
      (focusTarget || this.panel).focus({ preventScroll: true });
    });
  }

  cancel() {
    if (this.closing || !this.canClose()) return;
    this.onCancel();
    this.close();
  }

  close() {
    if (this.closing || !stack.includes(this)) return;
    this.panel.classList.remove("scale-100", "opacity-100");
    this.panel.classList.add("scale-95", "opacity-0");
    if (this.animateNativeClose && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.closing = true;
      this.panel.inert = true;
      this.root.classList.add("is-closing");
      this.closeTimer = setTimeout(() => this.finishClose(), 200);
      return;
    }
    this.finishClose();
  }

  finishClose() {
    stack.splice(stack.indexOf(this), 1);
    this.closing = false;
    this.root.classList.remove("is-closing");
    this.root.setAttribute("aria-hidden", "true");
    if (this.root.tagName === "DIALOG") this.root.close();
    syncBackground();
    this.root.inert = true;
    const target = this.restoreFocus(this.previousFocus);
    if (target?.isConnected && !target.closest("[inert]") && !target.disabled)
      target.focus({ preventScroll: true });
    else stack.at(-1)?.panel.focus();
    const hide = () => {
      this.root.classList.add("hidden");
      this.root.classList.remove("flex");
    };
    if (this.animateNativeClose) {
      this.panel.inert = false;
      hide();
    }
    else this.closeTimer = setTimeout(hide, 200);
  }
}
