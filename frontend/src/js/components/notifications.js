const types = {
  success: { label: "موفق", icon: "m5 12 4 4L19 6" },
  error: { label: "خطا", icon: "m7 7 10 10M17 7 7 17", urgent: true },
  warning: {
    label: "هشدار",
    icon: "M10.3 4.8 3.2 17a2 2 0 0 0 1.7 3h14.2a2 2 0 0 0 1.7-3L13.7 4.8a2 2 0 0 0-3.4 0ZM12 9v4m0 3h.01",
    urgent: true,
  },
  info: {
    label: "اطلاع",
    icon: "M12 11v6m0-10h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
  },
};

const visibleLimit = 3;
const pending = [];
const visible = new Set();
let stack, statusRegion, alertRegion;

function liveRegion(role) {
  const region = document.createElement("div");
  region.className = "sr-only";
  region.setAttribute("role", role);
  region.setAttribute("aria-atomic", "false");
  region.setAttribute("aria-relevant", "additions");
  return region;
}

function initializeStack() {
  stack = document.createElement("div");
  stack.className = "notification-stack";
  if (stack.showPopover) stack.setAttribute("popover", "manual");
  statusRegion = liveRegion("status");
  alertRegion = liveRegion("alert");
  stack.append(statusRegion, alertRegion);

  document.addEventListener(
    "toggle",
    (event) => {
      if (visible.size && event.target.matches("dialog")) {
        const dialog = event.target.matches(":modal")
          ? event.target
          : undefined;
        positionStack(dialog);
      }
    },
    true,
  );

  window.addEventListener("pagehide", () => {
    pending.length = 0;
    for (const notice of visible) {
      clearTimeout(notice.timer);
      notice.slot.remove();
      notice.announcement.remove();
    }
    visible.clear();
    closeStack();
  });
}

function positionStack(openingDialog) {
  // A modal makes its siblings inert. Keep the live regions inside the active
  // modal and use a popover to escape its clipping and reach the top layer.
  const dialog =
    document.activeElement?.closest("dialog:modal") ??
    openingDialog ??
    stack.parentElement?.closest("dialog:modal") ??
    Array.from(document.querySelectorAll("dialog:modal")).at(-1);
  const parent = stack.showPopover && dialog ? dialog : document.body;
  if (stack.parentElement !== parent) {
    stack.hidePopover?.();
    parent.append(stack);
  }
  if (stack.showPopover && !stack.matches(":popover-open")) stack.showPopover();
}

function closeStack() {
  stack.hidePopover?.();
  stack.remove();
}

function render(notice) {
  const { label, icon, urgent } = types[notice.type];
  const slot = document.createElement("div");
  slot.className = "notification-slot";
  slot.setAttribute("aria-hidden", "true");
  slot.innerHTML = `
    <div class="notification-clip">
      <div class="notification-popup" data-type="${notice.type}">
        <span class="notification-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="${icon}"></path>
          </svg>
        </span>
        <span class="notification-copy"><strong>${label}</strong> <bdi></bdi></span>
      </div>
    </div>`;
  slot.querySelector("bdi").textContent = notice.message;
  notice.slot = slot;

  const announcement = document.createElement("div");
  announcement.textContent = `${label}، ${notice.message}`;
  notice.announcement = announcement;
  stack.append(slot);
  positionStack();
  // Let assistive technology register the live regions before adding content.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (visible.has(notice) && !notice.exiting) {
        (urgent ? alertRegion : statusRegion).append(announcement);
      }
    }),
  );
  notice.timer = setTimeout(() => dismiss(notice), notice.duration);
}

function showPending() {
  while (pending.length && visible.size < visibleLimit) {
    const notice = pending.shift();
    visible.add(notice);
    render(notice);
  }
}

async function dismiss(notice) {
  const queued = pending.indexOf(notice);
  if (queued !== -1) {
    pending.splice(queued, 1);
    return;
  }
  if (!visible.has(notice) || notice.exiting) return;
  notice.exiting = true;
  clearTimeout(notice.timer);
  notice.slot.dataset.exiting = "";
  await Promise.allSettled(
    (notice.slot.getAnimations?.({ subtree: true }) ?? []).map(
      (animation) => animation.finished,
    ),
  );
  if (!visible.delete(notice)) return;
  notice.slot.remove();
  notice.announcement.remove();
  showPending();
  if (!visible.size) closeStack();
}

// The returned function dismisses this notification, including while queued.
export function notify(message, { type = "info", duration = 4000 } = {}) {
  if (!message) return;
  if (!stack) initializeStack();
  const notice = {
    message,
    type:
      typeof type === "string" && Object.hasOwn(types, type) ? type : "info",
    duration,
  };
  pending.push(notice);
  showPending();
  return () => dismiss(notice);
}
