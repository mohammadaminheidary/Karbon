import {
  protectPage,
} from "../guards/auth-guard.js";

import {
  logout,
} from "../auth/auth-storage.js";

import {
  MembersApiError,
  createMember,
  deleteMember,
  getMembers,
  updateMember,
} from "../members/members-api.js";


const numberFormatter =
  new Intl.NumberFormat("fa-IR");


const SETTINGS_SECTIONS =
  new Set([
    "general",
    "members",
    "appearance",
    "security",
    "backup",
  ]);


const DELETE_GRACE_SECONDS = 7;


let members = [];

let membersLoaded = false;

let membersLoading = false;

let editingMemberId = null;

let deletingMemberId = null;

let deleteCountdownIntervalId = null;

let deleteCountdownActive = false;

let deleteRequestInFlight = false;

let deleteSecondsRemaining = 0;

let toastTimeoutId = null;


/* ======================================================
   Helpers
====================================================== */

function getElement(id) {
  return document.getElementById(
    id
  );
}


function createElement(
  tagName,
  className = ""
) {
  const element =
    document.createElement(
      tagName
    );


  if (className) {
    element.className =
      className;
  }


  return element;
}


function getMemberFullName(
  member
) {
  return [
    member?.first_name,
    member?.last_name,
  ]
    .filter(Boolean)
    .join(" ")
    .trim() || "بدون نام";
}


/* ======================================================
   Authentication
====================================================== */

function setupLogout() {
  const button =
    getElement(
      "logoutButton"
    );


  if (!button) {
    return;
  }


  button.addEventListener(
    "click",
    () => {
      logout();

      window.location.replace(
        "/page/login-page.html"
      );
    }
  );
}


function handleUnauthorized(
  error
) {
  if (
    error instanceof
      MembersApiError &&
    error.status === 401
  ) {
    logout();

    window.location.replace(
      "/page/login-page.html"
    );

    return true;
  }


  return false;
}


/* ======================================================
   Toast
====================================================== */

function showToast(
  message,
  type = "success"
) {
  const toast =
    getElement(
      "settingsToast"
    );


  if (!toast) {
    return;
  }


  if (toastTimeoutId) {
    clearTimeout(
      toastTimeoutId
    );
  }


  toast.textContent =
    message;


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


  toastTimeoutId =
    window.setTimeout(
      () => {
        toast.classList.add(
          "hidden"
        );
      },
      3000
    );
}


/* ======================================================
   Settings Navigation
====================================================== */

function getInitialSettingsSection() {
  const section =
    window.location.hash
      .replace("#", "")
      .trim();


  if (
    SETTINGS_SECTIONS.has(
      section
    )
  ) {
    return section;
  }


  return "general";
}


function setSettingsButtonState(
  button,
  active
) {
  if (!button) {
    return;
  }


  button.classList.remove(
    "bg-persian-blue",
    "text-white",
    "shadow-sm",
    "text-mirage/60",
    "hover:bg-alabaster",
    "hover:text-mirage"
  );


  if (active) {
    button.classList.add(
      "bg-persian-blue",
      "text-white",
      "shadow-sm"
    );

  } else {
    button.classList.add(
      "text-mirage/60",
      "hover:bg-alabaster",
      "hover:text-mirage"
    );
  }
}


async function showSettingsSection(
  requestedSection,
  {
    updateHash = true,
  } = {}
) {
  const section =
    SETTINGS_SECTIONS.has(
      requestedSection
    )
      ? requestedSection
      : "general";


  document
    .querySelectorAll(
      "[data-settings-panel]"
    )
    .forEach(
      (panel) => {
        const active =
          panel.dataset
            .settingsPanel ===
          section;


        panel.classList.toggle(
          "hidden",
          !active
        );
      }
    );


  document
    .querySelectorAll(
      "[data-settings-target]"
    )
    .forEach(
      (button) => {
        const active =
          button.dataset
            .settingsTarget ===
          section;


        setSettingsButtonState(
          button,
          active
        );
      }
    );


  if (updateHash) {
    history.replaceState(
      null,
      "",
      `${window.location.pathname}#${section}`
    );
  }


  if (
    section === "members" &&
    !membersLoaded &&
    !membersLoading
  ) {
    await loadMembers();
  }
}


function setupSettingsNavigation() {
  document
    .querySelectorAll(
      "[data-settings-target]"
    )
    .forEach(
      (button) => {
        button.addEventListener(
          "click",
          async () => {
            await showSettingsSection(
              button.dataset
                .settingsTarget
            );
          }
        );
      }
    );


  document
    .querySelectorAll(
      "[data-open-settings-section]"
    )
    .forEach(
      (button) => {
        button.addEventListener(
          "click",
          async () => {
            await showSettingsSection(
              button.dataset
                .openSettingsSection
            );
          }
        );
      }
    );


  window.addEventListener(
    "hashchange",
    async () => {
      await showSettingsSection(
        getInitialSettingsSection(),
        {
          updateHash: false,
        }
      );
    }
  );
}


/* ======================================================
   Members State
====================================================== */

function setMembersState(
  state
) {
  const loading =
    getElement(
      "settingsMembersLoading"
    );

  const error =
    getElement(
      "settingsMembersError"
    );

  const empty =
    getElement(
      "settingsMembersEmpty"
    );

  const table =
    getElement(
      "settingsMembersTable"
    );


  [
    loading,
    error,
    empty,
    table,
  ].forEach(
    (element) => {
      element?.classList.add(
        "hidden"
      );
    }
  );


  switch (state) {
    case "loading":
      loading?.classList.remove(
        "hidden"
      );
      break;

    case "error":
      error?.classList.remove(
        "hidden"
      );
      break;

    case "ready":
      table?.classList.remove(
        "hidden"
      );
      break;

    case "empty":
    default:
      empty?.classList.remove(
        "hidden"
      );
      break;
  }
}


/* ======================================================
   Members Render
====================================================== */

function createMemberRow(
  member
) {
  const row =
    createElement(
      "tr",
      "transition-colors hover:bg-alabaster/60"
    );


  const memberCell =
    createElement(
      "td",
      "px-5 py-4"
    );


  const wrapper =
    createElement(
      "div",
      "flex items-center gap-3"
    );


  const avatar =
    createElement(
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
      ].join(" ")
    );


  avatar.textContent =
    getMemberFullName(
      member
    ).charAt(0);


  const identity =
    createElement("div");


  const name =
    createElement(
      "p",
      "text-sm font-black text-mirage"
    );


  name.textContent =
    getMemberFullName(
      member
    );


  const id =
    createElement(
      "p",
      "mt-1 text-[11px] text-mirage/35"
    );


  id.textContent =
    `شناسه #${numberFormatter.format(
      member.id
    )}`;


  identity.append(
    name,
    id
  );


  wrapper.append(
    avatar,
    identity
  );


  memberCell.appendChild(
    wrapper
  );


  const phoneCell =
    createElement(
      "td",
      "px-5 py-4 text-sm text-mirage/60"
    );


  phoneCell.dir =
    "ltr";

  phoneCell.textContent =
    member.phone || "—";


  const nationalIdCell =
    createElement(
      "td",
      "px-5 py-4 text-sm text-mirage/60"
    );


  nationalIdCell.dir =
    "ltr";

  nationalIdCell.textContent =
    member.national_id || "—";


  const actionsCell =
    createElement(
      "td",
      "px-5 py-4"
    );


  const actions =
    createElement(
      "div",
      "flex items-center gap-2"
    );


  const editButton =
    createElement(
      "button",
      "rounded-lg bg-persian-blue/10 px-3 py-2 text-xs font-bold text-persian-blue transition-colors hover:bg-persian-blue hover:text-white"
    );


  editButton.type =
    "button";

  editButton.textContent =
    "ویرایش";


  editButton.addEventListener(
    "click",
    () => {
      openEditMemberModal(
        member
      );
    }
  );


  const deleteButton =
    createElement(
      "button",
      "rounded-lg bg-alizarin-crimson/10 px-3 py-2 text-xs font-bold text-alizarin-crimson transition-colors hover:bg-alizarin-crimson hover:text-white"
    );


  deleteButton.type =
    "button";

  deleteButton.textContent =
    "حذف";


  deleteButton.addEventListener(
    "click",
    () => {
      openDeleteModal(
        member
      );
    }
  );


  actions.append(
    editButton,
    deleteButton
  );


  actionsCell.appendChild(
    actions
  );


  row.append(
    memberCell,
    phoneCell,
    nationalIdCell,
    actionsCell
  );


  return row;
}


function renderMembers() {
  const body =
    getElement(
      "settingsMembersTableBody"
    );

  const count =
    getElement(
      "settingsMembersCount"
    );


  if (count) {
    count.textContent =
      numberFormatter.format(
        members.length
      );
  }


  if (!body) {
    return;
  }


  body.innerHTML = "";


  if (members.length === 0) {
    setMembersState(
      "empty"
    );

    return;
  }


  members.forEach(
    (member) => {
      body.appendChild(
        createMemberRow(
          member
        )
      );
    }
  );


  setMembersState(
    "ready"
  );
}


/* ======================================================
   Load Members
====================================================== */

async function loadMembers() {
  if (membersLoading) {
    return;
  }


  membersLoading =
    true;


  setMembersState(
    "loading"
  );


  try {
    const data =
      await getMembers();


    members =
      Array.isArray(data)
        ? data
        : [];


    membersLoaded =
      true;


    renderMembers();

  } catch (error) {
    membersLoaded =
      false;


    if (
      handleUnauthorized(
        error
      )
    ) {
      return;
    }


    console.error(
      error
    );


    const message =
      getElement(
        "settingsMembersErrorMessage"
      );


    if (message) {
      message.textContent =
        error instanceof
          MembersApiError
          ? error.message
          : "لطفاً دوباره تلاش کنید.";
    }


    setMembersState(
      "error"
    );

  } finally {
    membersLoading =
      false;
  }
}


/* ======================================================
   Member Form Modal
====================================================== */

function openMemberFormModal() {
  const modal =
    getElement(
      "memberFormModal"
    );


  modal?.classList.remove(
    "hidden"
  );

  modal?.classList.add(
    "flex"
  );


  document.body.classList.add(
    "overflow-hidden"
  );
}


function closeMemberFormModal() {
  const modal =
    getElement(
      "memberFormModal"
    );


  modal?.classList.add(
    "hidden"
  );

  modal?.classList.remove(
    "flex"
  );


  document.body.classList.remove(
    "overflow-hidden"
  );


  editingMemberId =
    null;


  getElement(
    "memberForm"
  )?.reset();


  hideFormError();
}


function openCreateMemberModal() {
  editingMemberId =
    null;


  const title =
    getElement(
      "memberFormTitle"
    );

  const saveButton =
    getElement(
      "saveMemberButton"
    );


  if (title) {
    title.textContent =
      "افزودن عضو";
  }


  if (saveButton) {
    saveButton.textContent =
      "ذخیره عضو";
  }


  getElement(
    "memberForm"
  )?.reset();


  hideFormError();

  openMemberFormModal();


  getElement(
    "memberFirstName"
  )?.focus();
}


function openEditMemberModal(
  member
) {
  editingMemberId =
    member.id;


  const title =
    getElement(
      "memberFormTitle"
    );

  const saveButton =
    getElement(
      "saveMemberButton"
    );


  if (title) {
    title.textContent =
      "ویرایش عضو";
  }


  if (saveButton) {
    saveButton.textContent =
      "ذخیره تغییرات";
  }


  getElement(
    "memberFirstName"
  ).value =
    member.first_name || "";


  getElement(
    "memberLastName"
  ).value =
    member.last_name || "";


  getElement(
    "memberPhone"
  ).value =
    member.phone || "";


  getElement(
    "memberNationalId"
  ).value =
    member.national_id || "";


  hideFormError();

  openMemberFormModal();
}


/* ======================================================
   Member Form
====================================================== */

function showFormError(
  message
) {
  const element =
    getElement(
      "memberFormError"
    );


  if (!element) {
    return;
  }


  element.textContent =
    message;

  element.classList.remove(
    "hidden"
  );
}


function hideFormError() {
  const element =
    getElement(
      "memberFormError"
    );


  if (!element) {
    return;
  }


  element.textContent = "";

  element.classList.add(
    "hidden"
  );
}


function getFormData() {
  const firstName =
    getElement(
      "memberFirstName"
    ).value.trim();


  const lastName =
    getElement(
      "memberLastName"
    ).value.trim();


  const phone =
    getElement(
      "memberPhone"
    ).value.trim();


  const nationalId =
    getElement(
      "memberNationalId"
    ).value.trim();


  if (!firstName) {
    throw new Error(
      "نام را وارد کنید."
    );
  }


  if (!lastName) {
    throw new Error(
      "نام خانوادگی را وارد کنید."
    );
  }


  return {
    first_name:
      firstName,

    last_name:
      lastName,

    phone:
      phone || null,

    national_id:
      nationalId || null,
  };
}


function setFormPending(
  pending
) {
  const button =
    getElement(
      "saveMemberButton"
    );


  if (!button) {
    return;
  }


  button.disabled =
    pending;


  if (pending) {
    button.textContent =
      "در حال ذخیره...";

    return;
  }


  button.textContent =
    editingMemberId
      ? "ذخیره تغییرات"
      : "ذخیره عضو";
}


async function handleMemberSubmit(
  event
) {
  event.preventDefault();


  hideFormError();


  let payload;


  try {
    payload =
      getFormData();

  } catch (error) {
    showFormError(
      error.message
    );

    return;
  }


  const memberId =
    editingMemberId;


  setFormPending(
    true
  );


  try {
    if (memberId) {
      await updateMember(
        memberId,
        payload
      );


      showToast(
        "اطلاعات عضو ویرایش شد."
      );

    } else {
      await createMember(
        payload
      );


      showToast(
        "عضو با موفقیت اضافه شد."
      );
    }


    closeMemberFormModal();


    membersLoaded =
      false;


    await loadMembers();

  } catch (error) {
    if (
      handleUnauthorized(
        error
      )
    ) {
      return;
    }


    console.error(
      error
    );


    showFormError(
      error instanceof
        MembersApiError
        ? error.message
        : "ذخیره اطلاعات انجام نشد."
    );

  } finally {
    setFormPending(
      false
    );
  }
}


/* ======================================================
   Delete
====================================================== */

function clearDeleteCountdown() {
  if (
    deleteCountdownIntervalId
  ) {
    clearInterval(
      deleteCountdownIntervalId
    );

    deleteCountdownIntervalId =
      null;
  }


  deleteCountdownActive =
    false;

  deleteSecondsRemaining =
    0;
}


function resetDeleteCountdownUI() {
  const box =
    getElement(
      "deleteCountdownBox"
    );

  const text =
    getElement(
      "deleteCountdownText"
    );

  const progress =
    getElement(
      "deleteCountdownProgress"
    );

  const confirmButton =
    getElement(
      "confirmDeleteMemberButton"
    );

  const cancelButton =
    getElement(
      "cancelDeleteMemberButton"
    );


  box?.classList.add(
    "hidden"
  );


  if (text) {
    text.textContent =
      "حذف عضو تا ۷ ثانیه دیگر...";
  }


  if (progress) {
    progress.style.width =
      "100%";
  }


  if (confirmButton) {
    confirmButton.disabled =
      false;

    confirmButton.textContent =
      "حذف عضو";
  }


  if (cancelButton) {
    cancelButton.disabled =
      false;

    cancelButton.textContent =
      "انصراف";
  }
}


function updateDeleteCountdownUI() {
  const box =
    getElement(
      "deleteCountdownBox"
    );

  const text =
    getElement(
      "deleteCountdownText"
    );

  const progress =
    getElement(
      "deleteCountdownProgress"
    );


  box?.classList.remove(
    "hidden"
  );


  if (text) {
    text.textContent =
      `حذف عضو تا ${numberFormatter.format(
        deleteSecondsRemaining
      )} ثانیه دیگر...`;
  }


  if (progress) {
    const percentage =
      (
        deleteSecondsRemaining /
        DELETE_GRACE_SECONDS
      ) * 100;


    progress.style.width =
      `${percentage}%`;
  }
}


function openDeleteModal(
  member
) {
  clearDeleteCountdown();

  resetDeleteCountdownUI();


  deleteRequestInFlight =
    false;

  deletingMemberId =
    member.id;


  const name =
    getElement(
      "deleteMemberName"
    );


  if (name) {
    name.textContent =
      getMemberFullName(
        member
      );
  }


  const modal =
    getElement(
      "deleteMemberModal"
    );


  modal?.classList.remove(
    "hidden"
  );

  modal?.classList.add(
    "flex"
  );


  document.body.classList.add(
    "overflow-hidden"
  );
}


function closeDeleteModal() {
  if (deleteRequestInFlight) {
    return;
  }


  clearDeleteCountdown();

  resetDeleteCountdownUI();


  deletingMemberId =
    null;


  const modal =
    getElement(
      "deleteMemberModal"
    );


  modal?.classList.add(
    "hidden"
  );

  modal?.classList.remove(
    "flex"
  );


  document.body.classList.remove(
    "overflow-hidden"
  );
}


function cancelPendingDelete() {
  if (deleteRequestInFlight) {
    return;
  }


  const pending =
    deleteCountdownActive;


  closeDeleteModal();


  if (pending) {
    showToast(
      "حذف عضو لغو شد."
    );
  }
}


async function executeDeleteMember() {
  if (
    !deletingMemberId ||
    deleteRequestInFlight
  ) {
    return;
  }


  const memberId =
    deletingMemberId;


  clearDeleteCountdown();


  deleteRequestInFlight =
    true;


  const text =
    getElement(
      "deleteCountdownText"
    );

  const progress =
    getElement(
      "deleteCountdownProgress"
    );

  const confirmButton =
    getElement(
      "confirmDeleteMemberButton"
    );

  const cancelButton =
    getElement(
      "cancelDeleteMemberButton"
    );


  if (text) {
    text.textContent =
      "در حال حذف عضو...";
  }


  if (progress) {
    progress.style.width =
      "0%";
  }


  if (confirmButton) {
    confirmButton.disabled =
      true;

    confirmButton.textContent =
      "در حال حذف...";
  }


  if (cancelButton) {
    cancelButton.disabled =
      true;
  }


  try {
    await deleteMember(
      memberId
    );


    deleteRequestInFlight =
      false;


    closeDeleteModal();


    showToast(
      "عضو با موفقیت حذف شد."
    );


    membersLoaded =
      false;


    await loadMembers();

  } catch (error) {
    deleteRequestInFlight =
      false;


    if (
      handleUnauthorized(
        error
      )
    ) {
      return;
    }


    console.error(
      error
    );


    resetDeleteCountdownUI();


    showToast(
      error instanceof
        MembersApiError
        ? error.message
        : "حذف عضو انجام نشد.",
      "error"
    );
  }
}


function startDeleteCountdown() {
  if (
    !deletingMemberId ||
    deleteCountdownActive ||
    deleteRequestInFlight
  ) {
    return;
  }


  deleteCountdownActive =
    true;

  deleteSecondsRemaining =
    DELETE_GRACE_SECONDS;


  const confirmButton =
    getElement(
      "confirmDeleteMemberButton"
    );

  const cancelButton =
    getElement(
      "cancelDeleteMemberButton"
    );


  if (confirmButton) {
    confirmButton.disabled =
      true;

    confirmButton.textContent =
      "در انتظار حذف...";
  }


  if (cancelButton) {
    cancelButton.textContent =
      "لغو حذف";
  }


  updateDeleteCountdownUI();


  deleteCountdownIntervalId =
    window.setInterval(
      () => {
        deleteSecondsRemaining -= 1;


        updateDeleteCountdownUI();


        if (
          deleteSecondsRemaining <= 0
        ) {
          clearInterval(
            deleteCountdownIntervalId
          );


          deleteCountdownIntervalId =
            null;


          executeDeleteMember();
        }
      },
      1000
    );
}


/* ======================================================
   Events
====================================================== */

function setupEvents() {
  getElement(
    "addMemberButton"
  )?.addEventListener(
    "click",
    openCreateMemberModal
  );


  getElement(
    "emptyAddMemberButton"
  )?.addEventListener(
    "click",
    openCreateMemberModal
  );


  getElement(
    "retryMembersButton"
  )?.addEventListener(
    "click",
    loadMembers
  );


  getElement(
    "closeMemberFormButton"
  )?.addEventListener(
    "click",
    closeMemberFormModal
  );


  getElement(
    "cancelMemberFormButton"
  )?.addEventListener(
    "click",
    closeMemberFormModal
  );


  getElement(
    "memberForm"
  )?.addEventListener(
    "submit",
    handleMemberSubmit
  );


  getElement(
    "cancelDeleteMemberButton"
  )?.addEventListener(
    "click",
    cancelPendingDelete
  );


  getElement(
    "confirmDeleteMemberButton"
  )?.addEventListener(
    "click",
    startDeleteCountdown
  );


  document.querySelector(
    "[data-member-modal-backdrop]"
  )?.addEventListener(
    "click",
    closeMemberFormModal
  );


  document.querySelector(
    "[data-delete-modal-backdrop]"
  )?.addEventListener(
    "click",
    cancelPendingDelete
  );


  document.addEventListener(
    "keydown",
    (event) => {
      if (
        event.key !==
        "Escape"
      ) {
        return;
      }


      closeMemberFormModal();

      cancelPendingDelete();
    }
  );
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
      updateHash: false,
    }
  );
}


if (
  document.readyState ===
  "loading"
) {
  document.addEventListener(
    "DOMContentLoaded",
    initSettingsPage
  );

} else {
  initSettingsPage();
}