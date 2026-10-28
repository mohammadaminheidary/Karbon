const MEMBER_STATE_IDS = {
  loading:
    "attendanceMembersLoading",

  error:
    "attendanceMembersError",

  empty:
    "attendanceInitialState",

  ready:
    "attendanceMembers",
};


function getElement(id) {
  return document.getElementById(
    id
  );
}


function hideElement(element) {
  if (!element) {
    return;
  }


  element.classList.add(
    "hidden"
  );
}


function showElement(element) {
  if (!element) {
    return;
  }


  element.classList.remove(
    "hidden"
  );
}


export function setMembersViewState(
  state
) {
  const members =
    getElement(
      MEMBER_STATE_IDS.ready
    );

  const loading =
    getElement(
      MEMBER_STATE_IDS.loading
    );

  const error =
    getElement(
      MEMBER_STATE_IDS.error
    );

  const empty =
    getElement(
      MEMBER_STATE_IDS.empty
    );


  [
    members,
    loading,
    error,
    empty,
  ].forEach(
    hideElement
  );


  switch (state) {
    case "loading":
      showElement(loading);
      break;

    case "error":
      showElement(error);
      break;

    case "ready":
      showElement(members);
      break;

    case "empty":
    default:
      showElement(empty);
      break;
  }
}