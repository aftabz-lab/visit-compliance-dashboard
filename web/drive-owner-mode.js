(function (global) {
  "use strict";

  const STORAGE_KEY = "shwapno-drive-owner-device-v1";
  const URL_KEY = "drive-owner";
  const EXPECTED_HASH = "207b9ced801c428b242b96868efe2c4c107f5941377b891940098d63d0a74afc";

  function readOwnerFlag() {
    try { return global.localStorage.getItem(STORAGE_KEY) === "enabled"; }
    catch { return false; }
  }

  function applyOwnerClass() {
    document.documentElement.classList.toggle("drive-owner", readOwnerFlag());
  }

  function setOwnerFlag(enabled) {
    try {
      if (enabled) global.localStorage.setItem(STORAGE_KEY, "enabled");
      else global.localStorage.removeItem(STORAGE_KEY);
    } catch {}
    applyOwnerClass();
    global.dispatchEvent(new CustomEvent("drive-owner-mode-change", { detail: { enabled: readOwnerFlag() } }));
  }

  function activationValue() {
    const query = new URL(global.location.href).searchParams.get(URL_KEY);
    if (query) return query;
    const match = global.location.hash.match(/^#drive-owner=(.+)$/i);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function cleanActivationUrl() {
    const url = new URL(global.location.href);
    url.searchParams.delete(URL_KEY);
    if (/^#drive-owner=/i.test(url.hash)) url.hash = "";
    global.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }

  async function sha256(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await global.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  }

  async function activateFromUrl() {
    const value = activationValue();
    if (!value) return readOwnerFlag();
    try {
      if (value.toLowerCase() === "off") setOwnerFlag(false);
      else if ((await sha256(value)) === EXPECTED_HASH) setOwnerFlag(true);
    } finally {
      cleanActivationUrl();
    }
    return readOwnerFlag();
  }

  applyOwnerClass();
  const ready = activateFromUrl();
  global.DashboardDriveOwner = Object.freeze({
    isOwner: readOwnerFlag,
    disable: () => setOwnerFlag(false),
    ready,
  });
})(window);
