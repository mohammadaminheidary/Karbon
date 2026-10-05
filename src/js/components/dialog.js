const stack = [];
const previousInert = new Map();

function syncBackground() {
  const top = stack.at(-1);
  if (!top) {
    previousInert.forEach((value, element) => {
      element.inert = value;
    });
    previousInert.clear();
    document.body.classList.remove("overflow-hidden");
    return;
  }
  for (const element of document.body.children) {
    if (element.tagName === "SCRIPT") continue;
    if (!previousInert.has(element)) previousInert.set(element, element.inert);
    element.inert = element !== top.root;
  }
  document.body.classList.add("overflow-hidden");
}

export class Dialog {
  constructor(id, { canClose = () => true, onCancel = () => {} } = {}) {
    this.root = document.getElementById(id);
    this.panel = this.root.querySelector(
      '[role="dialog"], [role="alertdialog"]',
    );
    this.panel.tabIndex = -1;
    this.canClose = canClose;
    this.onCancel = onCancel;
    this.root.querySelectorAll("[data-dialog-close]").forEach((button) => {
      button.addEventListener("click", () => this.cancel());
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
          'button, input, select, textarea, a[href], [tabindex="0"]',
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
    clearTimeout(this.closeTimer);
    if (!stack.includes(this)) {
      this.previousFocus = document.activeElement;
      stack.push(this);
    }
    this.root.classList.remove("hidden");
    this.root.classList.add("flex");
    this.root.setAttribute("aria-hidden", "false");
    syncBackground();
    requestAnimationFrame(() => {
      this.panel.classList.remove("scale-95", "opacity-0");
      this.panel.classList.add("scale-100", "opacity-100");
      (focusTarget || this.panel).focus();
    });
  }

  cancel() {
    if (!this.canClose()) return;
    this.onCancel();
    this.close();
  }

  close() {
    const index = stack.indexOf(this);
    if (index < 0) return;
    stack.splice(index, 1);
    this.panel.classList.remove("scale-100", "opacity-100");
    this.panel.classList.add("scale-95", "opacity-0");
    this.root.setAttribute("aria-hidden", "true");
    syncBackground();
    this.root.inert = true;
    if (
      this.previousFocus?.isConnected &&
      !this.previousFocus.closest("[inert]") &&
      !this.previousFocus.disabled
    )
      this.previousFocus.focus();
    else stack.at(-1)?.panel.focus();
    this.closeTimer = setTimeout(() => {
      this.root.classList.add("hidden");
      this.root.classList.remove("flex");
    }, 200);
  }
}
