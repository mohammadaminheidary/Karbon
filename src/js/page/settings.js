import { protectPage } from "../guards/auth-guard.js";

import { logout } from "../auth/auth-storage.js";

import {
  MembersApiError,
  createMember,
  deleteMember,
  getMembers,
  updateMember,
} from "../members/members-api.js";

const numberFormatter = new Intl.NumberFormat("fa-IR");

let members = [];
let editingMemberId = null;
let deletingMemberId = null;
let toastTimeoutId = null;
let membersLoaded = false;

/* ======================================================
   Helpers
====================================================== */

function getElement(id) {
  return document.getElementById(id);
}

function getMemberFullName(member) {
  return (
    [member?.first_name, member?.last_name].filter(Boolean).join(" ").trim() ||
    "بدون نام"
  );
}

function createElement(tagName, className = "") {
  const element = document.createElement(tagName);

  if (className) {
    element.className = className;
  }

  return element;
}

/* ======================================================
   Auth
====================================================== */

function setupLogout() {
  const button = getElement("logoutButton");

  if (!button) {
    return;
  }

  button.addEventListener("click", () => {
    logout();

    window.location.replace("/page/login-page.html");
  });
}

function handleUnauthorized(error) {
  if (error instanceof MembersApiError && error.status === 401) {
    logout();

    window.location.replace("/page/login-page.html");

    return true;
  }

  return false;
}

/* ======================================================
   Toast
====================================================== */

function showToast(message, type = "success") {
  const toast = getElement("settingsToast");

  if (!toast) {
    return;
  }

  if (toastTimeoutId) {
    clearTimeout(toastTimeoutId);
  }

  toast.textContent = message;

  toast.className = [
    "fixed",
    "left-6",
    "top-6",
    "z-[150]",
    "max-w-sm",
    "rounded-xl",
    "px-4",
    "py-3",
    "text-xs",
    "font-bold",
    "shadow-xl",

    type === "success"
      ? "bg-eucalyptus text-white"
      : "bg-alizarin-crimson text-white",
  ].join(" ");

  toastTimeoutId = window.setTimeout(() => {
    toast.classList.add("hidden");
  }, 3000);
}

/* ======================================================
   View State
====================================================== */

function setMembersState(state) {
  const loading = getElement("settingsMembersLoading");

  const error = getElement("settingsMembersError");

  const empty = getElement("settingsMembersEmpty");

  const table = getElement("settingsMembersTable");

  [loading, error, empty, table].forEach((element) => {
    element?.classList.add("hidden");
  });

  if (state === "loading") {
    loading?.classList.remove("hidden");
  }

  if (state === "error") {
    error?.classList.remove("hidden");
  }

  if (state === "empty") {
    empty?.classList.remove("hidden");
  }

  if (state === "ready") {
    table?.classList.remove("hidden");
  }
}

/* ======================================================
   Render
====================================================== */

function createMemberRow(member) {
  const row = createElement("tr", "transition-colors hover:bg-alabaster/60");

  const memberCell = createElement("td", "px-5 py-4");

  const memberWrapper = createElement("div", "flex items-center gap-3");

  const avatar = createElement(
    "div",
    [
      "flex",
      "h-10",
      "w-10",
      "shrink-0",
      "items-center",
      "justify-center",
      "rounded-xl",
      "bg-mirage",
      "font-black",
      "text-white",
    ].join(" "),
  );

  avatar.textContent = getMemberFullName(member).charAt(0);

  const identity = createElement("div");

  const name = createElement("p", "text-sm font-black text-mirage");

  name.textContent = getMemberFullName(member);

  const id = createElement("p", "mt-1 text-[11px] text-mirage/35");

  id.textContent = `شناسه #${numberFormatter.format(member.id)}`;

  identity.append(name, id);

  memberWrapper.append(avatar, identity);

  memberCell.appendChild(memberWrapper);

  const phoneCell = createElement("td", "px-5 py-4 text-sm text-mirage/60");

  phoneCell.dir = "ltr";

  phoneCell.textContent = member.phone || "—";

  const nationalIdCell = createElement(
    "td",
    "px-5 py-4 text-sm text-mirage/60",
  );

  nationalIdCell.dir = "ltr";

  nationalIdCell.textContent = member.national_id || "—";

  const actionsCell = createElement("td", "px-5 py-4");

  const actions = createElement("div", "flex items-center gap-2");

  const editButton = createElement(
    "button",
    "rounded-lg bg-persian-blue/10 px-3 py-2 text-xs font-bold text-persian-blue hover:bg-persian-blue hover:text-white",
  );

  editButton.type = "button";

  editButton.textContent = "ویرایش";

  editButton.addEventListener("click", () => {
    openEditMemberModal(member);
  });

  const deleteButton = createElement(
    "button",
    "rounded-lg bg-alizarin-crimson/10 px-3 py-2 text-xs font-bold text-alizarin-crimson hover:bg-alizarin-crimson hover:text-white",
  );

  deleteButton.type = "button";

  deleteButton.textContent = "حذف";

  deleteButton.addEventListener("click", () => {
    openDeleteModal(member);
  });

  actions.append(editButton, deleteButton);

  actionsCell.appendChild(actions);

  row.append(memberCell, phoneCell, nationalIdCell, actionsCell);

  return row;
}

function renderMembers() {
  const body = getElement("settingsMembersTableBody");

  const count = getElement("settingsMembersCount");

  if (count) {
    count.textContent = numberFormatter.format(members.length);
  }

  if (!body) {
    return;
  }

  body.innerHTML = "";

  if (members.length === 0) {
    setMembersState("empty");

    return;
  }

  members.forEach((member) => {
    body.appendChild(createMemberRow(member));
  });

  setMembersState("ready");
}

/* ======================================================
   Load Members
====================================================== */

async function loadMembers() {
  setMembersState("loading");

  try {
    const data = await getMembers();

    members = Array.isArray(data) ? data : [];
    membersLoaded = true;

    renderMembers();
  } catch (error) {
    if (handleUnauthorized(error)) {
      return;
    }

    console.error(error);

    const message = getElement("settingsMembersErrorMessage");

    if (message) {
      message.textContent =
        error instanceof MembersApiError
          ? error.message
          : "لطفاً دوباره تلاش کنید.";
    }

    setMembersState("error");
  }
}

/* ======================================================
   Member Form Modal
====================================================== */

function openMemberFormModal() {
  const modal = getElement("memberFormModal");

  modal?.classList.remove("hidden");

  modal?.classList.add("flex");

  document.body.classList.add("overflow-hidden");
}

function closeMemberFormModal() {
  const modal = getElement("memberFormModal");

  modal?.classList.add("hidden");

  modal?.classList.remove("flex");

  document.body.classList.remove("overflow-hidden");

  editingMemberId = null;

  const form = getElement("memberForm");

  form?.reset();

  hideFormError();
}

function openCreateMemberModal() {
  editingMemberId = null;

  const title = getElement("memberFormTitle");

  const saveButton = getElement("saveMemberButton");

  if (title) {
    title.textContent = "افزودن عضو";
  }

  if (saveButton) {
    saveButton.textContent = "ذخیره عضو";
  }

  getElement("memberForm")?.reset();

  hideFormError();

  openMemberFormModal();

  getElement("memberFirstName")?.focus();
}

function openEditMemberModal(member) {
  editingMemberId = member.id;

  const title = getElement("memberFormTitle");

  const saveButton = getElement("saveMemberButton");

  if (title) {
    title.textContent = "ویرایش عضو";
  }

  if (saveButton) {
    saveButton.textContent = "ذخیره تغییرات";
  }

  getElement("memberFirstName").value = member.first_name || "";

  getElement("memberLastName").value = member.last_name || "";

  getElement("memberPhone").value = member.phone || "";

  getElement("memberNationalId").value = member.national_id || "";

  hideFormError();

  openMemberFormModal();
}

/* ======================================================
   Form
====================================================== */

function showFormError(message) {
  const element = getElement("memberFormError");

  if (!element) {
    return;
  }

  element.textContent = message;

  element.classList.remove("hidden");
}

function hideFormError() {
  const element = getElement("memberFormError");

  if (!element) {
    return;
  }

  element.textContent = "";

  element.classList.add("hidden");
}

function getFormData() {
  const firstName = getElement("memberFirstName").value.trim();

  const lastName = getElement("memberLastName").value.trim();

  const phone = getElement("memberPhone").value.trim();

  const nationalId = getElement("memberNationalId").value.trim();

  if (!firstName) {
    throw new Error("نام را وارد کنید.");
  }

  if (!lastName) {
    throw new Error("نام خانوادگی را وارد کنید.");
  }

  return {
    first_name: firstName,

    last_name: lastName,

    phone: phone || null,

    national_id: nationalId || null,
  };
}

function setFormPending(isPending) {
  const button = getElement("saveMemberButton");

  if (!button) {
    return;
  }

  button.disabled = isPending;

  if (isPending) {
    button.textContent = "در حال ذخیره...";

    return;
  }

  button.textContent = editingMemberId ? "ذخیره تغییرات" : "ذخیره عضو";
}

async function handleMemberSubmit(event) {
  event.preventDefault();

  hideFormError();

  let payload;

  try {
    payload = getFormData();
  } catch (error) {
    showFormError(error.message);

    return;
  }

  setFormPending(true);

  try {
    if (editingMemberId) {
      await updateMember(editingMemberId, payload);

      showToast("اطلاعات عضو ویرایش شد.");
    } else {
      await createMember(payload);

      showToast("عضو با موفقیت اضافه شد.");
    }

    closeMemberFormModal();

    await loadMembers();
  } catch (error) {
    if (handleUnauthorized(error)) {
      return;
    }

    console.error(error);

    showFormError(
      error instanceof MembersApiError
        ? error.message
        : "ذخیره اطلاعات انجام نشد.",
    );
  } finally {
    setFormPending(false);
  }
}

/* ======================================================
   Delete
====================================================== */

function openDeleteModal(member) {
  deletingMemberId = member.id;

  const name = getElement("deleteMemberName");

  if (name) {
    name.textContent = getMemberFullName(member);
  }

  const modal = getElement("deleteMemberModal");

  modal?.classList.remove("hidden");

  modal?.classList.add("flex");

  document.body.classList.add("overflow-hidden");
}

function closeDeleteModal() {
  deletingMemberId = null;

  const modal = getElement("deleteMemberModal");

  modal?.classList.add("hidden");

  modal?.classList.remove("flex");

  document.body.classList.remove("overflow-hidden");
}

async function confirmDeleteMember() {
  if (!deletingMemberId) {
    return;
  }

  const button = getElement("confirmDeleteMemberButton");

  button.disabled = true;

  button.textContent = "در حال حذف...";

  try {
    await deleteMember(deletingMemberId);

    closeDeleteModal();

    showToast("عضو حذف شد.");

    await loadMembers();
  } catch (error) {
    if (handleUnauthorized(error)) {
      return;
    }

    console.error(error);

    showToast(
      error instanceof MembersApiError ? error.message : "حذف عضو انجام نشد.",
      "error",
    );
  } finally {
    button.disabled = false;

    button.textContent = "حذف عضو";
  }
}

/* ======================================================
   Settings Navigation
====================================================== */

const SETTINGS_SECTIONS = new Set([
  "general",
  "members",
  "appearance",
  "security",
  "backup",
]);

function getInitialSettingsSection() {
  const section = window.location.hash.replace("#", "").trim();

  if (SETTINGS_SECTIONS.has(section)) {
    return section;
  }

  return "general";
}

function setSettingsButtonState(button, isActive) {
  if (!button) {
    return;
  }

  button.classList.toggle("bg-persian-blue", isActive);

  button.classList.toggle("text-white", isActive);

  button.classList.toggle("shadow-sm", isActive);

  button.classList.toggle("text-mirage/60", !isActive);

  button.classList.toggle("hover:bg-alabaster", !isActive);

  button.classList.toggle("hover:text-mirage", !isActive);
}

async function showSettingsSection(sectionName, { updateUrl = true } = {}) {
  const section = SETTINGS_SECTIONS.has(sectionName) ? sectionName : "general";

  document.querySelectorAll("[data-settings-panel]").forEach((panel) => {
    const isActive = panel.dataset.settingsPanel === section;

    panel.classList.toggle("hidden", !isActive);
  });

  document.querySelectorAll("[data-settings-target]").forEach((button) => {
    setSettingsButtonState(button, button.dataset.settingsTarget === section);
  });

  if (updateUrl) {
    history.replaceState(null, "", `#${section}`);
  }

  if (section === "members" && !membersLoaded) {
    await loadMembers();
  }
}

function setupSettingsNavigation() {
  document.querySelectorAll("[data-settings-target]").forEach((button) => {
    button.addEventListener("click", () => {
      showSettingsSection(button.dataset.settingsTarget);
    });
  });

  document
    .querySelectorAll("[data-open-settings-section]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        showSettingsSection(button.dataset.openSettingsSection);
      });
    });

  window.addEventListener("hashchange", () => {
    showSettingsSection(getInitialSettingsSection(), {
      updateUrl: false,
    });
  });
}

/* ======================================================
   Events
====================================================== */

function setupEvents() {
  getElement("addMemberButton")?.addEventListener(
    "click",
    openCreateMemberModal,
  );

  getElement("emptyAddMemberButton")?.addEventListener(
    "click",
    openCreateMemberModal,
  );

  getElement("retryMembersButton")?.addEventListener("click", loadMembers);

  getElement("closeMemberFormButton")?.addEventListener(
    "click",
    closeMemberFormModal,
  );

  getElement("cancelMemberFormButton")?.addEventListener(
    "click",
    closeMemberFormModal,
  );

  getElement("memberForm")?.addEventListener("submit", handleMemberSubmit);

  getElement("cancelDeleteMemberButton")?.addEventListener(
    "click",
    closeDeleteModal,
  );

  getElement("confirmDeleteMemberButton")?.addEventListener(
    "click",
    confirmDeleteMember,
  );

  document
    .querySelector("[data-member-modal-backdrop]")
    ?.addEventListener("click", closeMemberFormModal);

  document
    .querySelector("[data-delete-modal-backdrop]")
    ?.addEventListener("click", closeDeleteModal);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }

    closeMemberFormModal();

    closeDeleteModal();
  });
}

/* ======================================================
   Init
====================================================== */

async function initSettingsPage() {
  const authenticated =
    await protectPage();


  if (!authenticated) {
    return;
  }


  setupLogout();

  setupEvents();

  setupSettingsNavigation();


  await showSettingsSection(
    getInitialSettingsSection(),
    {
      updateUrl: false,
    }
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initSettingsPage);
} else {
  initSettingsPage();
}
