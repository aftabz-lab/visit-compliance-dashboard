const SUPABASE_URL = "https://wstxgbzmsbosinmhhjbl.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_MCw_J7uorsKtmmokW1OpCg_Ej5DURhw";
const SNAPSHOT_TABLE = "dashboard_snapshots";
const SESSION_STORAGE_KEY = "visit_compliance_supabase_publisher_session_v1";
const SYNC_STATUS_KEY = "visit_compliance_supabase_sync_status_v1";

function safeJsonParse(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function getStoredSession() {
  try { return safeJsonParse(localStorage.getItem(SESSION_STORAGE_KEY), null); }
  catch { return null; }
}

function saveSession(session) {
  try {
    if (!session) localStorage.removeItem(SESSION_STORAGE_KEY);
    else localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {}
}

function recordSync(snapshotKey, status) {
  try {
    const all = safeJsonParse(localStorage.getItem(SYNC_STATUS_KEY), {}) || {};
    all[snapshotKey] = { ...status, at: new Date().toISOString() };
    localStorage.setItem(SYNC_STATUS_KEY, JSON.stringify(all));
    window.dispatchEvent(new CustomEvent("supabase-snapshot-sync", { detail: { snapshotKey, ...all[snapshotKey] } }));
  } catch {}
}

function normalizedSession(raw) {
  if (!raw?.access_token || !raw?.refresh_token) return null;
  const expiresIn = Number(raw.expires_in || 3600);
  return {
    access_token: raw.access_token,
    refresh_token: raw.refresh_token,
    token_type: raw.token_type || "bearer",
    expires_at: Number(raw.expires_at || (Date.now() + expiresIn * 1000)),
    user: raw.user || null,
  };
}

async function authRequest(path, body) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? safeJsonParse(text, { message: text }) : {};
  if (!response.ok) {
    throw new Error(payload?.msg || payload?.message || payload?.error_description || payload?.error || `Supabase Auth HTTP ${response.status}`);
  }
  return payload;
}

export async function signInPublisher(email, password) {
  const payload = await authRequest("/auth/v1/token?grant_type=password", { email, password });
  const session = normalizedSession(payload);
  if (!session) throw new Error("Supabase did not return a valid publisher session.");
  saveSession(session);
  return session;
}

export function signOutPublisher() {
  saveSession(null);
}

export function getPublisherSession() {
  return getStoredSession();
}

export function getSyncStatus() {
  try { return safeJsonParse(localStorage.getItem(SYNC_STATUS_KEY), {}) || {}; }
  catch { return {}; }
}

async function refreshPublisherSession() {
  const current = getStoredSession();
  if (!current?.refresh_token) return null;
  try {
    const payload = await authRequest("/auth/v1/token?grant_type=refresh_token", { refresh_token: current.refresh_token });
    const session = normalizedSession(payload);
    if (!session) throw new Error("Supabase did not return a refreshed session.");
    saveSession(session);
    return session;
  } catch (error) {
    saveSession(null);
    throw error;
  }
}

async function validPublisherSession(forceRefresh = false) {
  let session = getStoredSession();
  if (!session) return null;
  const expiresAt = Number(session.expires_at || 0);
  if (forceRefresh || !expiresAt || expiresAt <= Date.now() + 60_000) {
    session = await refreshPublisherSession();
  }
  return session;
}

function restHeaders(accessToken = null) {
  const headers = {
    apikey: SUPABASE_PUBLISHABLE_KEY,
    "Content-Type": "application/json",
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return headers;
}

export async function readCloudSnapshot(snapshotKey) {
  const url = `${SUPABASE_URL}/rest/v1/${SNAPSHOT_TABLE}?select=snapshot_key,payload,updated_at&snapshot_key=eq.${encodeURIComponent(snapshotKey)}&limit=1`;
  const response = await fetch(url, {
    method: "GET",
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY },
    cache: "no-store",
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Cloud snapshot read failed (${response.status})${text ? `: ${text.slice(0, 250)}` : ""}`);
  }
  const rows = await response.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function publishWithSession(snapshotKey, payload, session) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${SNAPSHOT_TABLE}?on_conflict=snapshot_key`, {
    method: "POST",
    headers: {
      ...restHeaders(session.access_token),
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      snapshot_key: snapshotKey,
      payload,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Cloud snapshot publish failed (${response.status})${text ? `: ${text.slice(0, 400)}` : ""}`);
    error.status = response.status;
    throw error;
  }
  return true;
}

export async function publishCloudSnapshot(snapshotKey, payload) {
  let session = await validPublisherSession(false);
  if (!session) {
    recordSync(snapshotKey, { ok: false, reason: "publisher-login-required" });
    const error = new Error("Publisher login required on this source PC.");
    error.code = "PUBLISHER_LOGIN_REQUIRED";
    throw error;
  }
  try {
    await publishWithSession(snapshotKey, payload, session);
  } catch (error) {
    if (error?.status === 401) {
      session = await validPublisherSession(true);
      if (!session) throw error;
      await publishWithSession(snapshotKey, payload, session);
    } else {
      throw error;
    }
  }
  recordSync(snapshotKey, { ok: true, reason: "published" });
  return true;
}

export async function publishIfSignedIn(snapshotKey, payload) {
  const session = getStoredSession();
  if (!session) {
    recordSync(snapshotKey, { ok: false, reason: "publisher-login-required" });
    return { published: false, reason: "publisher-login-required" };
  }
  try {
    await publishCloudSnapshot(snapshotKey, payload);
    return { published: true };
  } catch (error) {
    console.warn(`Supabase ${snapshotKey} sync failed:`, error);
    recordSync(snapshotKey, { ok: false, reason: error?.message || "publish-failed" });
    return { published: false, reason: error?.message || "publish-failed" };
  }
}

export const supabaseConfig = Object.freeze({
  url: SUPABASE_URL,
  projectRef: "wstxgbzmsbosinmhhjbl",
  table: SNAPSHOT_TABLE,
});
