/*
 * Shared Google Drive connection for the Shwapno dashboards.
 *
 * The storage keys intentionally match the Zone Distribution dashboard so a
 * folder selected there is immediately available to the portal, Z-Report,
 * Visit Compliance and Audit pages on the same aftabz-lab.github.io origin.
 * OAuth access is read-only. No client secret is used by this static site.
 */
(function (global) {
  "use strict";

  const KEYS = Object.freeze({
    clientId: "zone-google-client-id",
    apiKey: "zone-google-api-key",
    appId: "zone-google-app-id",
    folderId: "zone-gdrive-folder-id",
    folderName: "zone-gdrive-folder-name",
    accessToken: "shwapno-gdrive-access-token-v1",
    accessTokenExpiry: "shwapno-gdrive-access-token-expiry-v1",
  });
  const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
  let gisPromise = null;
  let pickerPromise = null;
  let tokenClient = null;
  let tokenClientId = "";

  function read(key) {
    try { return String(localStorage.getItem(key) || "").trim(); }
    catch { return ""; }
  }

  function write(key, value) {
    try {
      if (value == null || value === "") localStorage.removeItem(key);
      else localStorage.setItem(key, String(value));
    } catch { /* A blocked local store must not break the current connection. */ }
  }

  function getConfig() {
    return {
      clientId: read(KEYS.clientId),
      apiKey: read(KEYS.apiKey),
      appId: read(KEYS.appId),
    };
  }

  function configReady(config = getConfig()) {
    return Boolean(config.clientId && config.apiKey && config.appId);
  }

  function saveConfig(config) {
    const previous = getConfig();
    const next = {
      clientId: String(config?.clientId || "").trim(),
      apiKey: String(config?.apiKey || "").trim(),
      appId: String(config?.appId || "").trim(),
    };
    if (!configReady(next)) throw new Error("Enter the OAuth Client ID, API Key, and Project Number / App ID.");
    write(KEYS.clientId, next.clientId);
    write(KEYS.apiKey, next.apiKey);
    write(KEYS.appId, next.appId);
    if (previous.clientId !== next.clientId || previous.apiKey !== next.apiKey || previous.appId !== next.appId) clearToken();
    tokenClient = null;
    tokenClientId = "";
    return next;
  }

  function getFolder() {
    const id = read(KEYS.folderId);
    return id ? { id, name: read(KEYS.folderName) || "Google Drive folder" } : null;
  }

  function saveFolder(folder) {
    const id = String(folder?.id || "").trim();
    if (!id) throw new Error("No Google Drive folder was selected.");
    const value = { id, name: String(folder?.name || "Google Drive folder").trim() || "Google Drive folder" };
    write(KEYS.folderId, value.id);
    write(KEYS.folderName, value.name);
    return value;
  }

  function clearFolder() {
    write(KEYS.folderId, "");
    write(KEYS.folderName, "");
  }

  function cachedToken() {
    const token = read(KEYS.accessToken);
    const expiresAt = Number(read(KEYS.accessTokenExpiry) || 0);
    if (!token || !expiresAt || Date.now() >= expiresAt - 30000) {
      clearToken();
      return null;
    }
    return { token, expiresAt };
  }

  function rememberToken(token, expiresIn) {
    const seconds = Math.max(60, Number(expiresIn || 3600));
    const expiresAt = Date.now() + seconds * 1000;
    write(KEYS.accessToken, token);
    write(KEYS.accessTokenExpiry, expiresAt);
    return { token, expiresAt };
  }

  function clearToken() {
    write(KEYS.accessToken, "");
    write(KEYS.accessTokenExpiry, "");
  }

  function clearSetup() {
    Object.values(KEYS).forEach(key => write(key, ""));
    tokenClient = null;
    tokenClientId = "";
  }

  function loadScript(src, id) {
    if (document.getElementById(id)) {
      return new Promise((resolve, reject) => {
        const existing = document.getElementById(id);
        if (existing.dataset.loaded === "1") return resolve();
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", () => reject(new Error(`Could not load ${src}`)), { once: true });
      });
    }
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.id = id;
      script.src = src;
      script.async = true;
      script.defer = true;
      script.onload = () => { script.dataset.loaded = "1"; resolve(); };
      script.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.appendChild(script);
    });
  }

  async function ensureLibraries() {
    if (!gisPromise) {
      gisPromise = loadScript("https://accounts.google.com/gsi/client", "shwapno-google-gis")
        .then(() => {
          if (!global.google?.accounts?.oauth2) throw new Error("Google Identity Services did not load.");
        })
        .catch(error => { gisPromise = null; throw error; });
    }
    if (!pickerPromise) {
      pickerPromise = loadScript("https://apis.google.com/js/api.js", "shwapno-google-api")
        .then(() => new Promise((resolve, reject) => {
          try {
            global.gapi.load("picker", {
              callback: resolve,
              onerror: () => reject(new Error("Google Picker API did not load.")),
              timeout: 20000,
              ontimeout: () => reject(new Error("Google Picker API timed out.")),
            });
          } catch (error) { reject(error); }
        }))
        .catch(error => { pickerPromise = null; throw error; });
    }
    await Promise.all([gisPromise, pickerPromise]);
  }

  function getTokenClient() {
    const config = getConfig();
    if (!config.clientId) throw new Error("Google Drive setup is incomplete.");
    if (tokenClient && tokenClientId === config.clientId) return tokenClient;
    tokenClientId = config.clientId;
    tokenClient = global.google.accounts.oauth2.initTokenClient({
      client_id: config.clientId,
      scope: SCOPE,
      callback: () => {},
      error_callback: () => {},
    });
    return tokenClient;
  }

  async function requestToken({ forceConsent = false } = {}) {
    const existing = cachedToken();
    if (existing && !forceConsent) return existing.token;
    if (!configReady()) throw new Error("Google Drive setup is incomplete.");
    await ensureLibraries();
    return await new Promise((resolve, reject) => {
      const client = getTokenClient();
      client.callback = response => {
        if (response?.error) {
          clearToken();
          reject(new Error(response.error_description || response.error));
          return;
        }
        if (!response?.access_token) {
          reject(new Error("Google Drive did not return an access token."));
          return;
        }
        rememberToken(response.access_token, response.expires_in);
        resolve(response.access_token);
      };
      client.error_callback = response => {
        if (response?.type === "popup_closed") reject(Object.assign(new Error("Google Drive sign-in was cancelled."), { name: "AbortError" }));
        else reject(new Error(response?.message || "Google Drive sign-in failed."));
      };
      try {
        client.requestAccessToken({ prompt: forceConsent ? "consent" : "" });
      } catch (error) { reject(error); }
    });
  }

  async function openFolderPicker({ title = "Select shared dashboard data folder" } = {}) {
    const config = getConfig();
    if (!configReady(config)) throw new Error("Google Drive setup is incomplete.");
    const token = (cachedToken() || {}).token || await requestToken();
    await ensureLibraries();
    return await new Promise((resolve, reject) => {
      try {
        const view = new global.google.picker.DocsView();
        view.setIncludeFolders(true);
        view.setSelectFolderEnabled(true);
        view.setMimeTypes("application/vnd.google-apps.folder");
        let picker = null;
        const finishPicker = () => {
          try { picker?.setVisible(false); } catch (e) {}
          try { picker?.dispose?.(); } catch (e) {}
          picker = null;
        };
        picker = new global.google.picker.PickerBuilder()
          .setDeveloperKey(config.apiKey)
          .setAppId(config.appId)
          .setOAuthToken(token)
          .setOrigin(global.location.origin)
          .addView(view)
          .setTitle(title)
          .setCallback(data => {
            if (data.action === global.google.picker.Action.PICKED) {
              const doc = data[global.google.picker.Response.DOCUMENTS]?.[0];
              const id = doc?.[global.google.picker.Document.ID] || doc?.id;
              const name = doc?.[global.google.picker.Document.NAME] || doc?.name || "Google Drive folder";
              finishPicker();
              if (id) resolve(saveFolder({ id, name }));
              else reject(new Error("No Google Drive folder was selected."));
            } else if (data.action === global.google.picker.Action.CANCEL) {
              finishPicker();
              resolve(null);
            }
          })
          .build();
        picker.setVisible(true);
      } catch (error) { reject(error); }
    });
  }

  async function connect({ pickFolder = false, title } = {}) {
    let folder = getFolder();
    const token = await requestToken({ forceConsent: !folder });
    if (pickFolder || !folder) folder = await openFolderPicker({ title });
    return folder ? { token, folder } : null;
  }

  async function driveFetch(url, options = {}) {
    let token = cachedToken()?.token;
    if (!token) throw new Error("Google Drive authorization is required. Click Reconnect Google Drive.");
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(url, { ...options, headers });
    if (response.status === 401 || response.status === 403) {
      clearToken();
      let detail = "";
      try { detail = (await response.json())?.error?.message || ""; } catch {}
      throw new Error(detail || "Google Drive authorization expired. Click Reconnect Google Drive.");
    }
    if (!response.ok) throw new Error(`Google Drive request failed (${response.status}).`);
    return response;
  }

  async function listFolderFiles(folderId = getFolder()?.id) {
    if (!folderId) throw new Error("No shared Google Drive folder is selected.");
    const escapedId = String(folderId).replace(/'/g, "\\'");
    const query = `'${escapedId}' in parents and trashed = false`;
    let pageToken = "";
    const files = [];
    do {
      const url = new URL("https://www.googleapis.com/drive/v3/files");
      url.searchParams.set("q", query);
      url.searchParams.set("spaces", "drive");
      url.searchParams.set("pageSize", "1000");
      url.searchParams.set("orderBy", "modifiedTime desc,name");
      url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,modifiedTime,size,capabilities(canDownload),driveId)");
      url.searchParams.set("supportsAllDrives", "true");
      url.searchParams.set("includeItemsFromAllDrives", "true");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const data = await (await driveFetch(url.toString())).json();
      files.push(...(data.files || []));
      pageToken = data.nextPageToken || "";
    } while (pageToken);
    return files;
  }

  function remoteSignature(meta) {
    return [meta?.id || "", meta?.name || "", meta?.size || "", meta?.modifiedTime || ""].join("|");
  }

  async function downloadFile(meta) {
    if (!meta?.id) throw new Error("Google Drive file ID is missing.");
    const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(meta.id)}?alt=media&supportsAllDrives=true`);
    const blob = await response.blob();
    return new File([blob], meta.name || "drive-file", {
      type: blob.type || meta.mimeType || "application/octet-stream",
      lastModified: Date.parse(meta.modifiedTime || "") || Date.now(),
    });
  }

  function describe() {
    const config = getConfig();
    const folder = getFolder();
    const token = cachedToken();
    return { config, configReady: configReady(config), folder, authorized: Boolean(token), expiresAt: token?.expiresAt || 0 };
  }

  global.ShwapnoDrive = Object.freeze({
    KEYS, SCOPE, getConfig, configReady, saveConfig, clearSetup,
    getFolder, saveFolder, clearFolder, cachedToken, clearToken,
    ensureLibraries, requestToken, openFolderPicker, connect,
    listFolderFiles, downloadFile, remoteSignature, describe,
  });
  if (configReady()) setTimeout(() => { ensureLibraries().catch(() => {}); }, 0);
})(window);
