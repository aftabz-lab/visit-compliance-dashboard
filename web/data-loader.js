/*
 * Visit Compliance Dashboard
 *
 * Three-level, last-successful-snapshot loader:
 *   1. Current generated snapshot in site/data/dashboard_data.json
 *   2. Last successful snapshot stored in this browser
 *   3. Last successful snapshot committed to the repository
 *
 * The third level makes the dashboard safe on a new browser or device after
 * the raw Excel files have been removed from data/.
 */

const CURRENT_DATA_URL = "./data/dashboard_data.json";
const LAST_GOOD_DATA_URL = "./data/dashboard_data_last_good.json";

const LAST_DATA_KEY = "visit_compliance_last_successful_data";
const LAST_FETCH_KEY = "visit_compliance_last_successful_fetch";

function validDashboardData(data) {
  return Boolean(
    data
      && typeof data === "object"
      && !Array.isArray(data)
      && data.metadata
      && typeof data.metadata === "object"
      && Array.isArray(data.officers)
      && data.officers.length > 0
      && data.details
      && typeof data.details === "object"
  );
}

async function fetchSnapshot(url, label) {
  const response = await fetch(`${url}?_=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);

  const data = await response.json();
  if (!validDashboardData(data)) throw new Error(`${label} is empty or invalid`);
  return data;
}

function cacheSnapshot(data, timestamp) {
  try {
    localStorage.setItem(LAST_DATA_KEY, JSON.stringify(data));
    localStorage.setItem(LAST_FETCH_KEY, timestamp);
  } catch (error) {
    console.warn("Visit Compliance browser cache unavailable:", error);
  }
}

function cachedSnapshot() {
  try {
    const cachedData = localStorage.getItem(LAST_DATA_KEY);
    if (!cachedData) return null;

    const data = JSON.parse(cachedData);
    if (!validDashboardData(data)) return null;

    return {
      data,
      lastFetched: localStorage.getItem(LAST_FETCH_KEY) || null,
    };
  } catch (error) {
    console.warn("Visit Compliance browser cache is unavailable or invalid:", error);
    return null;
  }
}

export async function loadDashboardData() {
  try {
    const data = await fetchSnapshot(CURRENT_DATA_URL, "Current dashboard snapshot");
    const timestamp = new Date().toISOString();
    cacheSnapshot(data, timestamp);
    return { data, source: "current", usingLastData: false, lastFetched: timestamp };
  } catch (currentError) {
    console.warn("Current dashboard snapshot unavailable. Trying the retained snapshot.", currentError);
  }

  // Mirror the Audit Quality Dashboard: use this browser's last successful
  // load first, then use the permanent repository-level fallback.
  const cached = cachedSnapshot();
  if (cached) {
    return { ...cached, source: "browser-cache", usingLastData: true };
  }

  try {
    const data = await fetchSnapshot(LAST_GOOD_DATA_URL, "Last-good dashboard snapshot");
    const timestamp = new Date().toISOString();
    cacheSnapshot(data, timestamp);
    return { data, source: "published-backup", usingLastData: true, lastFetched: timestamp };
  } catch (fallbackError) {
    throw new Error(
      "The current dashboard snapshot and the retained last-good snapshot could not be loaded. "
      + "Run the workflow once with the raw Excel files present."
    );
  }
}

export function getDataStatus(result) {
  if (result.source === "current") {
    return { type: "current", text: "Showing the latest published snapshot." };
  }

  if (result.source === "published-backup") {
    return {
      type: "published-backup",
      text: "Current data is unavailable. Showing the last successful published snapshot.",
    };
  }

  const date = result.lastFetched ? new Date(result.lastFetched) : null;
  const formattedDate = date && !Number.isNaN(date.getTime())
    ? date.toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
    : "a previous successful update";

  return {
    type: "browser-cache",
    text: `Current data is unavailable. Showing this browser's last successful snapshot (${formattedDate}).`,
  };
}

export function clearCachedDashboardData() {
  localStorage.removeItem(LAST_DATA_KEY);
  localStorage.removeItem(LAST_FETCH_KEY);
}
