import { attachGoogleDriveDataSource, getDataStatus, loadDashboardData } from "./data-loader.js?v=visit-interactions-v3-trend";
import { publishIfSignedIn, readCloudSnapshot } from "./supabase-sync.js?v=visit-compliance-v12-supabase";

const ALL_OFFICERS = "__ALL_OFFICERS__";
const ALL_REMARKS = "__ALL_REMARKS__";
const NEVER_VISITED_REMARK = "Never visited outlet";
const THEME_KEY = "visit-compliance-theme";
const AUDIT_FIELDS = ["Response ID", "Site Code", "Question Category", "Question Title", "Question Max Score", "Answer Score", "Date"];
const AUDIT_PUBLISHED_SOURCES = ["./data/audit_data.json", "./data/audit_data_last_good.json"];
const LEGACY_SHARED_SNAPSHOT_URL = "./data/shared_snapshot.json";
const TABLE_COLUMNS = [
  ["officer", "Officer"],
  ["planned", "Planned (Till)"],
  ["completed", "Completed"],
  ["pending", "Pending"],
  ["completionPct", "Completion %"]
];
const state = {
  data: null,
  dataLoad: null,
  outletSearch: "",
  selectedOutlet: null,
  status: "All statuses",
  officerKey: ALL_OFFICERS,
  search: "",
  sortKey: "completionPct",
  sortDir: -1,
  activeView: null,
  detailRemark: ALL_REMARKS,
  detailOutletCodeSearch: "",
  detailOutletNameSearch: "",
  auditScores: new Map(),
  auditScoreStatus: "loading",
  auditScoreSource: "",
};
const $ = id => document.getElementById(id);
const numberFmt = new Intl.NumberFormat("en-US");

function applyTheme(theme) {
  const next = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  document.documentElement.style.colorScheme = next;
  const btn = $("theme-toggle");
  if (btn) btn.textContent = next === "dark" ? "Light theme" : "Dark theme";
}
let savedTheme = "light";
try { savedTheme = localStorage.getItem(THEME_KEY) || "light"; } catch {}
applyTheme(savedTheme);

const DASHBOARD_DESKTOP_WIDTH = 1420;
const DASHBOARD_SIDE_GAP = 12;
let dashboardFitHost = null;
let dashboardFitShell = null;
let dashboardFitFrame = 0;
let dashboardFitObserver = null;
let dashboardFitLayoutWidth = DASHBOARD_DESKTOP_WIDTH;

function useDesktopDashboardAutoFit() {
  const finePointer = window.matchMedia?.("(pointer: fine)")?.matches;
  const screenWidth = Number(window.screen?.width || window.innerWidth || 0);
  return Boolean(finePointer || screenWidth >= 900);
}

function dashboardScaleForWidth(viewportWidth, layoutWidth) {
  const availableWidth = Math.max(1, Number(viewportWidth || 0) - (DASHBOARD_SIDE_GAP * 2));
  return Math.min(1, availableWidth / Math.max(1, Number(layoutWidth || DASHBOARD_DESKTOP_WIDTH)));
}

function fitDashboardToViewport() {
  dashboardFitFrame = 0;
  if (!dashboardFitHost || !dashboardFitShell) return;

  dashboardFitShell.style.width = `${dashboardFitLayoutWidth}px`;
  dashboardFitShell.style.maxWidth = "none";
  dashboardFitLayoutWidth = Math.max(
    dashboardFitLayoutWidth,
    DASHBOARD_DESKTOP_WIDTH,
    Math.ceil(dashboardFitShell.scrollWidth || 0)
  );
  dashboardFitShell.style.width = `${dashboardFitLayoutWidth}px`;

  const viewportWidth = document.documentElement.clientWidth || window.innerWidth || dashboardFitLayoutWidth;
  const scale = dashboardScaleForWidth(viewportWidth, dashboardFitLayoutWidth);
  if (scale < 0.999) {
    dashboardFitShell.style.marginLeft = `${DASHBOARD_SIDE_GAP}px`;
    dashboardFitShell.style.marginRight = "0";
    dashboardFitShell.style.transformOrigin = "top left";
    dashboardFitShell.style.transform = `scale(${scale})`;

    const computed = getComputedStyle(dashboardFitShell);
    const marginTop = parseFloat(computed.marginTop) || 0;
    const marginBottom = parseFloat(computed.marginBottom) || 0;
    const fittedHeight = marginTop + (dashboardFitShell.offsetHeight * scale) + marginBottom;
    dashboardFitHost.style.height = `${Math.ceil(fittedHeight)}px`;
  } else {
    dashboardFitShell.style.removeProperty("margin-left");
    dashboardFitShell.style.removeProperty("margin-right");
    dashboardFitShell.style.removeProperty("transform-origin");
    dashboardFitShell.style.removeProperty("transform");
    dashboardFitHost.style.removeProperty("height");
  }
  dashboardFitHost.dataset.fitScale = scale.toFixed(4);
  if (window.scrollX) window.scrollTo(0, window.scrollY);
}

function scheduleDashboardAutoFit() {
  if (!dashboardFitHost || dashboardFitFrame) return;
  dashboardFitFrame = requestAnimationFrame(fitDashboardToViewport);
}

function installDashboardAutoFit() {
  if (!useDesktopDashboardAutoFit()) return;
  const shell = $("main-content");
  if (!shell || $("dashboard-autofit-host")) return;

  document.documentElement.classList.add("dashboard-autofit-desktop");
  const style = document.createElement("style");
  style.id = "dashboard-autofit-styles";
  style.textContent = `
    html.dashboard-autofit-desktop,
    html.dashboard-autofit-desktop body { max-width: 100%; overflow-x: hidden !important; }
    html.dashboard-autofit-desktop #dashboard-autofit-host { width: 100%; max-width: 100%; position: relative; display: flow-root; }
    html.dashboard-autofit-desktop .dashboard-shell { margin-top: 24px; margin-bottom: 36px; gap: 18px; }
    html.dashboard-autofit-desktop .hero-card h1 { font-size: clamp(34px, 3vw, 46px); }
    html.dashboard-autofit-desktop .hero-subtitle { font-size: 20px; }
    html.dashboard-autofit-desktop .hero-header,
    html.dashboard-autofit-desktop .panel-head,
    html.dashboard-autofit-desktop .details-title { flex-direction: row; align-items: flex-start; }
    html.dashboard-autofit-desktop .outlet-card-head { flex-direction: row; align-items: center; }
    html.dashboard-autofit-desktop .hero-actions { justify-content: flex-end; }
    html.dashboard-autofit-desktop .panel-actions,
    html.dashboard-autofit-desktop .details-actions { justify-content: flex-start; }
    html.dashboard-autofit-desktop .hero-actions > *,
    html.dashboard-autofit-desktop .panel-actions > *,
    html.dashboard-autofit-desktop .details-actions > *,
    html.dashboard-autofit-desktop .admin-actions > * { width: auto; }
    html.dashboard-autofit-desktop .summary-layout { grid-template-columns: 390px minmax(0, 1fr); }
    html.dashboard-autofit-desktop .filter-grid { grid-template-columns: 1.35fr 1fr 1fr 1fr; }
    html.dashboard-autofit-desktop .kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    html.dashboard-autofit-desktop .source-meta { grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, .8fr) minmax(0, 1fr); }
    html.dashboard-autofit-desktop .outlet-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    html.dashboard-autofit-desktop .view-tabs { overflow: visible; flex-wrap: wrap; padding-bottom: 0; }
    html.dashboard-autofit-desktop .details-summary { display: flex; }
    html.dashboard-autofit-desktop .detail-table { min-width: 1240px; }
    html.dashboard-autofit-desktop .trend-col { width: 74px; }
    html.dashboard-autofit-desktop .trend-chart { gap: 10px !important; }
    html.dashboard-autofit-desktop .trend-bar-wrap { height: 140px; }
    html.dashboard-autofit-desktop .trend-date { font-size: 10.5px; }
  `;
  document.head.appendChild(style);

  const host = document.createElement("div");
  host.id = "dashboard-autofit-host";
  const supportsOverflowClip = typeof CSS !== "undefined" && CSS.supports?.("overflow", "clip");
  host.style.overflow = supportsOverflowClip ? "clip" : "hidden";
  shell.parentNode.insertBefore(host, shell);
  host.appendChild(shell);
  dashboardFitHost = host;
  dashboardFitShell = shell;

  window.addEventListener("resize", scheduleDashboardAutoFit, { passive: true });
  window.addEventListener("orientationchange", scheduleDashboardAutoFit, { passive: true });
  window.addEventListener("load", scheduleDashboardAutoFit, { once: true });
  document.fonts?.ready?.then(scheduleDashboardAutoFit).catch(() => {});
  if ("ResizeObserver" in window) {
    dashboardFitObserver = new ResizeObserver(scheduleDashboardAutoFit);
    dashboardFitObserver.observe(shell);
  }
  scheduleDashboardAutoFit();
}

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit", timeZone: "UTC" });
}
function fmtSnapshotTimestamp(value) {
  const ts = value ? new Date(value) : null;
  if (!ts || Number.isNaN(ts.getTime())) return "Not available";
  return ts.toLocaleString("en-US", {
    day: "numeric", month: "short", year: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
    timeZone: "Asia/Dhaka"
  });
}
function esc(v) { return String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function pct(v) { return v == null || Number.isNaN(Number(v)) ? "—" : `${Number(v).toFixed(1)}%`; }
function lower(v) { return String(v ?? "").toLowerCase(); }

function unpackAuditRows(rawPayload) {
  const payload = rawPayload?.audit && !rawPayload?.rows ? rawPayload.audit : rawPayload;
  if (!payload || !Array.isArray(payload.rows) || !payload.rows.length) return null;

  if (payload.format === "dict-v1") {
    const dictionaries = payload.dictionaries || {};
    const required = ["responseIds", "siteCodes", "categories", "questions", "dates"];
    if (!required.every(key => Array.isArray(dictionaries[key]))) return null;
    return payload.rows.map(row => [
      dictionaries.responseIds[row[0]] ?? "",
      dictionaries.siteCodes[row[1]] ?? "",
      dictionaries.categories[row[2]] ?? "",
      dictionaries.questions[row[3]] ?? "",
      row[4],
      row[5],
      dictionaries.dates[row[6]] ?? "",
    ]);
  }

  if (!Array.isArray(payload.fields)) return null;
  const indexes = AUDIT_FIELDS.map(field => payload.fields.indexOf(field));
  if (indexes.some(index => index < 0)) return null;
  return payload.rows
    .filter(Array.isArray)
    .map(row => indexes.map(index => row[index]));
}

function auditDateRank(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value ?? "").trim();
  if (!text) return -Infinity;
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : -Infinity;
}

function auditResponseRank(value) {
  const text = String(value ?? "").trim();
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : text;
}

function calculateLatestAuditScores(packedRows) {
  const latest = new Map();
  for (const row of packedRows || []) {
    const siteCode = String(row[1] ?? "").trim().toUpperCase();
    const responseId = String(row[0] ?? "").trim();
    if (!siteCode || !responseId) continue;
    const date = auditDateRank(row[6]);
    const responseRank = auditResponseRank(responseId);
    const current = latest.get(siteCode);
    const newerDate = !current || date > current.date;
    const sameDateNewerResponse = current && date === current.date
      && ((typeof responseRank === "number" && typeof current.responseRank === "number")
        ? responseRank > current.responseRank
        : String(responseRank) > String(current.responseRank));
    if (newerDate || sameDateNewerResponse) {
      latest.set(siteCode, { responseId, responseRank, date, dateText: String(row[6] ?? "") });
    }
  }

  const totals = new Map();
  for (const row of packedRows || []) {
    const siteCode = String(row[1] ?? "").trim().toUpperCase();
    const responseId = String(row[0] ?? "").trim();
    const selected = latest.get(siteCode);
    if (!selected || selected.responseId !== responseId) continue;
    const available = parseFloat(row[4]);
    const earned = parseFloat(row[5]);
    if (!Number.isFinite(available) || available <= 0 || !Number.isFinite(earned)) continue;
    const total = totals.get(siteCode) || { earned: 0, available: 0 };
    total.earned += earned;
    total.available += available;
    totals.set(siteCode, total);
  }

  const scores = new Map();
  totals.forEach((total, siteCode) => {
    const selected = latest.get(siteCode);
    scores.set(siteCode, {
      ...total,
      score: 100 * total.earned / total.available,
      responseId: selected?.responseId || "",
      date: selected?.dateText || "",
    });
  });
  return scores;
}

async function readAuditCache() {
  if (!("indexedDB" in window)) return null;
  try {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("audit-dash", 2);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("h")) database.createObjectStore("h");
        if (!database.objectStoreNames.contains("cache")) database.createObjectStore("cache");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const cached = await new Promise(resolve => {
      const request = db.transaction("cache").objectStore("cache").get("last");
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
    if (!cached?.packed?.length) return null;
    return {
      packedRows: cached.packed,
      updatedAt: Number(cached.savedAt || 0),
      source: "saved Audit dashboard snapshot",
    };
  } catch {
    return null;
  }
}

async function readPublishedAudit(url, source) {
  try {
    const response = await fetch(`${url}?_=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return null;
    const payload = await response.json();
    const packedRows = unpackAuditRows(payload);
    if (!packedRows?.length) return null;
    return {
      packedRows,
      updatedAt: Date.parse(payload?.metadata?.generatedAt || "") || 0,
      source,
    };
  } catch {
    return null;
  }
}

async function loadAuditScores() {
  const [cached, cloud] = await Promise.all([
    readAuditCache(),
    readCloudSnapshot("audit").then(row => {
      const packedRows = unpackAuditRows(row?.payload);
      if (!packedRows?.length) return null;
      return {
        packedRows,
        updatedAt: Date.parse(row?.payload?.metadata?.generatedAt || row?.updated_at || "") || 0,
        source: "Audit cloud snapshot",
      };
    }).catch(() => null),
  ]);

  let selected = cloud;
  if (cached && (!selected || cached.updatedAt > selected.updatedAt)) selected = cached;

  if (!selected) {
    for (const url of AUDIT_PUBLISHED_SOURCES) {
      selected = await readPublishedAudit(url, "published Audit snapshot");
      if (selected) break;
    }
  }

  if (!selected) {
    try {
      const response = await fetch(`${LEGACY_SHARED_SNAPSHOT_URL}?_=${Date.now()}`, { cache: "no-store" });
      if (response.ok) {
        const payload = await response.json();
        const packedRows = unpackAuditRows(payload?.audit);
        if (packedRows?.length) {
          selected = {
            packedRows,
            updatedAt: Date.parse(payload?.audit?.metadata?.generatedAt || payload?.generatedAt || "") || 0,
            source: "legacy shared Audit snapshot",
          };
        }
      }
    } catch {}
  }

  if (!selected) return { scores: new Map(), source: "" };
  return { scores: calculateLatestAuditScores(selected.packedRows), source: selected.source };
}

function normalizedOfficerName(value) {
  return lower(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(?:mr|mrs|ms)\.?\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function selectedOutletOfficerNames() {
  const outlet = state.selectedOutlet ? state.data?.outlets?.[state.selectedOutlet] : null;
  if (!outlet) return null;
  return new Set([outlet.zonalName, outlet.rhoName]
    .map(normalizedOfficerName)
    .filter(Boolean));
}

function officerRowsForSelectedOutlet() {
  const names = selectedOutletOfficerNames();
  if (!names) return state.data.officers;
  return state.data.officers.filter(row => names.has(normalizedOfficerName(row.officer)));
}

function getOfficerRowsFiltered() {
  const q = state.search.trim().toLowerCase();
  return officerRowsForSelectedOutlet().filter(r => {
    if (state.status !== "All statuses" && r.status !== state.status) return false;
    if (state.officerKey !== ALL_OFFICERS && r.officerKey !== state.officerKey) return false;
    if (q && !lower(r.officer).includes(q)) return false;
    return true;
  });
}

function distinctNeverOutlets(rows) {
  const set = new Set();
  rows.forEach(r => (state.data.details[r.officerKey]?.neverVisited || []).forEach(x => set.add(x.siteCode)));
  return set.size;
}

function total(rows, key) { return rows.reduce((t, r) => t + (Number(r[key]) || 0), 0); }
function totalCompleted(rows) { return rows.reduce((t, r) => t + ((Number(r.distinctPlannedVisitsCompleted) || 0) + (Number(r.otherUnplannedResponses) || 0)), 0); }

function kpiScopeLabel(rows) {
  const officers = [...new Map((rows || [])
    .filter(row => row?.officer)
    .map(row => [row.officerKey || `${row.status}::${row.officer}`, row])).values()];
  if (officers.length === 1) return officers[0].officer;

  const statuses = new Set(officers.map(row => lower(row.status)));
  if (statuses.size === 1 && statuses.has("zonal")) return "All Zonal";
  if (statuses.size === 1 && statuses.has("rho")) return "All RHO";

  if (!officers.length) {
    if (lower(state.status) === "zonal") return "All Zonal";
    if (lower(state.status) === "rho") return "All RHO";
  }
  return "National";
}

function rowsWithDerived(rows) {
  return rows.map(r => ({
    ...r,
    planned: Number(r.totalPlannedTillDate) || 0,
    completed: (Number(r.distinctPlannedVisitsCompleted) || 0) + (Number(r.otherUnplannedResponses) || 0),
    pending: Number(r.remainingVisits) || 0,
  }));
}

function sortedOfficerRows(rows) {
  const withDerived = rowsWithDerived(rows);
  const key = state.sortKey;
  const dir = state.sortDir;
  return [...withDerived].sort((a, b) => {
    const av = a[key], bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number" || typeof bv === "number") return (Number(av) - Number(bv)) * dir;
    return String(av).localeCompare(String(bv), undefined, { sensitivity: "base" }) * dir;
  });
}

function renderHeader() {
  const m = state.data.metadata;
  document.title = m.title || "Visit Compliance Dashboard";
  $("page-title").textContent = "Visit Compliance";
  $("subtitle").textContent = "Management view · plan, execution and exceptions";
  const snapshot = m.snapshotDate ? fmtDate(m.snapshotDate) : "Not available";
  $("snapshot-line").textContent = `Latest response snapshot: ${snapshot}`;
  $("snapshot-note").textContent = "Planned Visits (Till Date) means all scheduled visits due up to the snapshot date. Completion % = (Completed planned visits + extra / unplanned responses) ÷ Planned Visits (Till Date).";
  renderDataSource();

  const statuses = ["All statuses", ...new Set(state.data.officers.map(r => r.status))];
  $("status-filter").innerHTML = statuses.map(v => `<option>${esc(v)}</option>`).join("");
  updateOfficerOptions();
}

function renderDataSource() {
  const m = state.data.metadata || {};
  const dataLoad = state.dataLoad || {};
  const source = dataLoad.source || "awaiting-drive";
  const localStatus = dataLoad.localStatus || {};
  const isDrive = source === "google-drive";
  const isSaved = source === "local-cache" || source === "published-shared";
  const sourceBadge = $("data-source-badge");
  const publicSnapshot = $("public-snapshot-time");
  const snapshotTakenAt = source === "published-shared"
    ? (dataLoad.lastFetched || m.snapshotTakenAt || m.generatedAt)
    : (m.snapshotTakenAt || m.generatedAt || dataLoad.lastFetched);
  if (publicSnapshot) publicSnapshot.textContent = `Last snapshot: ${state.data?.officers?.length ? fmtSnapshotTimestamp(snapshotTakenAt) : "Not published yet"}`;
  if (sourceBadge) {
    sourceBadge.textContent = isDrive ? "Google Drive Live" : isSaved ? "Saved snapshot" : "Google Drive required";
    sourceBadge.className = `status-pill${isDrive ? " live" : isSaved ? " secondary" : " warning"}`;
  }
  $("data-source-file").textContent = m.responseFile || "Response workbook";
  $("data-source-sheet").textContent = `Sheet: ${m.responseSheet || "Response Summary"}`;
  $("data-source-count").textContent = Number.isFinite(Number(m.diagnostics?.acceptedResponses)) ? `${numberFmt.format(Number(m.diagnostics.acceptedResponses))} accepted responses` : "Accepted responses unavailable";
  $("data-source-taken").textContent = fmtSnapshotTimestamp(snapshotTakenAt);
  $("data-source-note").textContent = `${localStatus.message || getDataStatus(dataLoad).text} Attendance punch data is matched from the attendance workbook when available.`;
  const grant = $("grant-folder");
  if (grant) grant.textContent = localStatus.kind === "reading" ? "Working…" : "Reconnect Google Drive";
}

function updateOfficerOptions() {
  const previous = state.officerKey;
  const source = officerRowsForSelectedOutlet()
    .filter(r => state.status === "All statuses" || r.status === state.status)
    .sort((a, b) => a.officer.localeCompare(b.officer, undefined, { sensitivity: "base" }));
  const nameCounts = new Map();
  source.forEach(r => nameCounts.set(r.officer, (nameCounts.get(r.officer) || 0) + 1));
  const options = [`<option value="${ALL_OFFICERS}">All officers</option>`].concat(source.map(r => {
    const label = nameCounts.get(r.officer) > 1 ? `${r.status} — ${r.officer}` : r.officer;
    return `<option value="${esc(r.officerKey)}">${esc(label)}</option>`;
  }));
  $("officer-filter").innerHTML = options.join("");
  if (source.some(r => r.officerKey === previous)) {
    $("officer-filter").value = previous;
  } else {
    state.officerKey = ALL_OFFICERS;
    $("officer-filter").value = ALL_OFFICERS;
  }
}

function renderKpis(rows, officerKey = null) {
  const planned = total(rows, "totalPlannedTillDate");
  const completed = totalCompleted(rows);
  const pending = total(rows, "remainingVisits");
  const never = distinctNeverOutlets(rows);
  const completion = planned ? (completed / planned) * 100 : null;
  const scopeLabel = kpiScopeLabel(rows);

  const cards = [
    { id: "completion", tone: "success", label: "Visit Completion %", value: completion == null ? "—" : `${completion.toFixed(1)}%`, meta: "Completed visits ÷ planned visits (till date)" },
    { id: "pending", tone: "danger", label: "Pending Visits", value: numberFmt.format(pending), meta: "No response yet" },
    { id: "never", tone: "warning", label: "Never Visited Outlets", value: numberFmt.format(never), meta: "Till date" },
    { id: "completed", tone: "success", label: "Completed Visits (Till Date)", value: numberFmt.format(completed), meta: "Completed planned visits + extra / unplanned responses" },
    { id: "planned", tone: "info", label: "Planned Visits (Till Date)", value: numberFmt.format(planned), meta: "Visits scheduled up to the snapshot date" },
    { id: "accepted", tone: "info", label: "Accepted Responses", value: numberFmt.format(total(rows, "acceptedResponses")), meta: "Survey responses accepted from the workbook" }
  ];

  $("kpis").innerHTML = cards.map(card => `
    <div class="kpi-card" data-tone="${card.tone}" data-kpi-card="${card.id}">
      <div class="kpi-label">${card.label}</div>
      <button type="button" class="kpi-action" data-kpi="${card.id}">${card.value}</button>
      <div class="kpi-meta">${card.meta}</div>
      <div class="kpi-meta">${esc(scopeLabel)}</div>
    </div>`).join("");

  $("kpis").querySelectorAll(".kpi-action").forEach(btn => btn.addEventListener("click", () => {
    showView(officerKey
      ? { type: "officer", officerKey, metric: btn.dataset.kpi }
      : { type: "aggregate", metric: btn.dataset.kpi });
  }));
}

// Accounts for every gap between the row count in the response workbook and the
// figure shown on screen, so a mismatch can be traced rather than guessed at.
function renderReconciliation(meta) {
  const target = $("reconciliation");
  if (!target) return;
  const d = meta?.diagnostics || {};
  const n = v => numberFmt.format(Number(v) || 0);
  const inFile = Number(d.acceptedInFile) || 0;
  const rejected = Number(d.rejectedResponseRows) || 0;
  const dupes = Number(d.duplicateResponseIdsIgnored) || 0;
  const rawRows = inFile + rejected + dupes;
  const afterSnap = Number(d.afterSnapshotIgnored) || 0;
  const accepted = Number(d.acceptedResponses) || 0;
  const unmapped = Number(d.unmappedOfficerResponses) || 0;
  const unscheduled = Number(d.responsesForUnscheduledOutlets) || 0;

  const steps = [
    ["Rows in the response workbook", rawRows, "", ""],
    ["Rejected — missing Response ID, Date, Site Code or Officer", -rejected, "drop", "These rows cannot be attributed to an outlet or officer."],
    ["Ignored — duplicate Response ID", -dupes, "drop", "The same Response ID appears more than once; only the first is kept."],
    ["Accepted from the file", inFile, "sub", ""],
    [`Ignored — dated after the snapshot (${meta?.snapshotDate || "snapshot"})`, -afterSnap, "drop", "Responses recorded after the snapshot date are out of scope."],
    ["Accepted responses (counted)", accepted, "total", ""],
  ];

  target.innerHTML = `
    <div class="panel-head"><h2>Response reconciliation</h2>
      <p class="panel-caption">From workbook rows to the figure on the cards</p></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Step</th><th class="num">Rows</th><th>Why</th></tr></thead>
      <tbody>${steps.map(([label, value, kind, why]) => `
        <tr class="recon-${kind}">
          <td>${kind === "drop" ? "↳ " : ""}<b>${esc(label)}</b></td>
          <td class="num" style="color:${kind === "drop" && value ? "#ff9f9f" : "inherit"};font-weight:${kind === "total" ? 800 : 600}">
            ${kind === "drop" ? (value ? n(value) : "0") : n(value)}</td>
          <td class="recon-why">${esc(why)}</td>
        </tr>`).join("")}
      </tbody>
    </table></div>
    <p class="recon-note">Of the ${n(accepted)} accepted, ${n(unscheduled)} are for outlets with no planned visit in the schedule
      and ${n(unmapped)} could not be matched to a named officer — both are still counted as responses, but they do not
      close a planned visit, which is why <b>Completed Visits</b> can differ from <b>Accepted Responses</b>.</p>`;
}


/* ── Visit-score trend ─────────────────────────────────────────────────
   Fed only by the "Trend" workbook via window.TrendSource. Nothing here
   touches state.data, and no compliance or audit figure reads trendState,
   so this file can never affect any other number on the dashboard.      */
const TREND_CLOUD_SNAPSHOT_KEY = "visit-trend";
const TREND_CACHE_KEY = "shwapno-visit-trend-cache-v6-legacy-mmdd-repair";
const TREND_RULE_VERSION = "latest-daily-mmdd-max-v4";
const LEGACY_TREND_RULE = "rule:latest-daily-v2";
const LEGACY_TREND_TOTAL_POSSIBLE = 290;
const trendState = {
  outlets: null,
  fileName: "",
  sheet: "",
  code: "",
  error: "",
  maxScore: 0,
  maxFromColumn: false,
  published: null,
  signature: "",
  driveSignature: "",
  publishedSignature: "",
};
let trendDriveLoadPromise = null;

function trendRuleSignature(sourceSignature) {
  const base = String(sourceSignature || "").trim();
  return base ? `${base}|rule:${TREND_RULE_VERSION}` : `rule:${TREND_RULE_VERSION}`;
}

function trendDayKey(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : text.toLowerCase();
}

function isLegacyTrendPayload(sourceSignature) {
  return String(sourceSignature || "").includes(LEGACY_TREND_RULE);
}

// The already-published v2 snapshot converted ambiguous MM/DD text as DD/MM.
// Its ISO values can be repaired deterministically: v2 swapped only dates whose
// original day was 1-12, while dates with a day above 12 were already correct.
function repairLegacyTrendDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return text;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (day < 1 || day > 12 || month < 1 || month > 12) return text;
  return `${match[1]}-${String(day).padStart(2, "0")}-${String(month).padStart(2, "0")}`;
}

function normalizeTrendPayloadVisits(visits, sourceSignature) {
  const legacy = isLegacyTrendPayload(sourceSignature);
  const repaired = legacy ? (visits || []).map((visit) => {
    if (!visit || typeof visit !== "object") return visit;
    const max = Number(visit.max) || 0;
    return {
      ...visit,
      date: repairLegacyTrendDate(visit.date),
      // The v2 reader missed the workbook's "Total Possible Score" header.
      // The supplied legacy workbook uses 290; new parses retain the row value.
      max: max > 0 ? max : LEGACY_TREND_TOTAL_POSSIBLE,
    };
  }) : visits;
  return normalizeTrendVisits(repaired);
}

// Legacy published/cache payloads may already contain same-day duplicates.
// Keep the last stored score for each calendar day as a display-layer safety
// net; the Trend workbook parser separately uses the latest actual time.
function normalizeTrendVisits(visits) {
  const latestByDate = new Map();
  for (const visit of visits || []) {
    if (!visit || typeof visit !== "object") continue;
    const dateKey = trendDayKey(visit.date);
    if (!dateKey) continue;
    latestByDate.set(dateKey, { dateKey, visit });
  }
  return [...latestByDate.values()]
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey))
    .slice(-(window.TrendSource?.LAST_N || 6))
    .map(item => item.visit);
}

function trendTone(v, max) {
  const share = max > 0 ? v / max : 0;
  if (share >= 0.85) return "#3fb27f";
  if (share >= 0.7) return "#8cc152";
  if (share >= 0.5) return "#e0a53f";
  return "#d9534f";
}

function trendShare(visit, denominator) {
  const direct = Number(visit?.percent);
  if (Number.isFinite(direct) && direct > 0) return direct <= 1 ? direct * 100 : direct;
  const own = Number(visit?.max) || denominator;
  return own > 0 ? (100 * Number(visit?.score || 0) / own) : 0;
}

function trendOutletName(code, trendEntry = null) {
  const dashboardName = code ? state.data?.outlets?.[code]?.outletName : "";
  return String(dashboardName || trendEntry?.name || "").trim();
}

function trendOutletLine(code, trendEntry = null) {
  if (!code) {
    return '<span style="font-size:13px;color:var(--muted)">Select an outlet to view its trend</span>';
  }
  const name = trendOutletName(code, trendEntry);
  return `<span style="font-size:13.5px;color:var(--text)">${esc(code)}${name ? ` (<strong>${esc(name)}</strong>)` : ""}</span>`;
}

function renderTrend() {
  const panel = $("trend-panel");
  if (!panel) return;
  panel.hidden = false;
  const selectedCode = state.selectedOutlet ? String(state.selectedOutlet).toUpperCase() : "";

  // No Trend workbook yet: say so plainly and offer to open one directly,
  // rather than leaving an empty space with no explanation.
  if (!trendState.outlets || !trendState.outlets.size) {
    panel.innerHTML = `
      <div class="panel-head"><h2>Visit score trend</h2>
        <p class="panel-caption">Last ${window.TrendSource ? window.TrendSource.LAST_N : 6} visits per outlet</p></div>
      <div class="trend-controls">${trendOutletLine(selectedCode)}</div>
      <div class="trend-empty">${!selectedCode
        ? "The last six visits will appear here automatically after an outlet is selected."
        : trendState.error
          ? `Could not read the Trend workbook: ${esc(trendState.error)}`
          : "No workbook named <b>Trend</b> was found in the connected Google Drive folder."}</div>
      <div class="trend-pick">
        <button type="button" id="trend-connect">Connect Google Drive &amp; load Trend</button>
        <button type="button" id="trend-open">Open the Trend workbook</button>
      </div>`;
    $("trend-open")?.addEventListener("click", () => $("trend-file")?.click());
    $("trend-connect")?.addEventListener("click", async () => {
      const drive = window.ShwapnoDrive;
      if (!drive?.connect) { trendState.error = "Drive module not available"; setTrendToggle(); renderTrend(); return; }
      try {
        trendState.error = "connecting…"; setTrendToggle(); renderTrend();
        await drive.connect({});                 // user asked for it, so the prompt is expected
        trendState.driveSignature = "";
        await loadTrendFromDrive();
        if (!trendState.outlets?.size) {
          if (!trendState.error || trendState.error === "connecting…") {
            trendState.error = "connected, but no file named Trend in that folder";
          }
          setTrendToggle(); renderTrend();
        }
      } catch (error) {
        trendState.error = error?.message || "could not connect";
        setTrendToggle(); renderTrend();
      }
    });
    return;
  }

  const codes = [...trendState.outlets.keys()].sort();
  trendState.code = selectedCode;
  const entry = trendState.outlets.get(trendState.code);
  const visits = normalizeTrendVisits(entry?.visits || []);

  if (!selectedCode) {
    panel.innerHTML = `
      <div class="panel-head"><h2>Visit score trend</h2>
        <p class="panel-caption">Last ${window.TrendSource ? window.TrendSource.LAST_N : 6} visits · from ${esc(trendState.fileName || "Trend workbook")}</p></div>
      <div class="trend-controls">
        ${trendOutletLine("")}
        <span class="trend-note">${codes.length.toLocaleString()} outlets in ${esc(trendState.fileName || "the Trend file")}</span>
      </div>
      <div class="trend-empty">The last six visits will appear here automatically after an outlet is selected.</div>`;
    return;
  }

  // Percentage of the score available, so bars compare across dates and outlets.
  const denom = Number(trendState.maxScore)
    || Math.max(1, ...visits.map(v => Number(v.max) || 0), ...visits.map(v => v.score));
  const max = 100;

  panel.innerHTML = `
    <div class="panel-head"><h2>Visit score trend</h2>
      <p class="panel-caption">Last ${window.TrendSource ? window.TrendSource.LAST_N : 6} visits · from ${esc(trendState.fileName || "Trend workbook")}</p></div>
    <div class="trend-controls">
      ${trendOutletLine(trendState.code, entry)}
      <span class="trend-note">${codes.length.toLocaleString()} outlets in ${esc(trendState.fileName || "the Trend file")}</span>
    </div>
    ${visits.length ? `<div class="trend-chart">${visits.map(v => {
      const share = trendShare(v, denom);
      const h = Math.max(4, Math.round(140 * share / max));
      return `<div class="trend-col">
        <span class="trend-val" style="color:${trendTone(share, max)}">${share.toFixed(0)}%</span>
        <span class="trend-bar-wrap"><span class="trend-bar" style="height:${h}px;background:${trendTone(share, max)}"></span></span>
        <span class="trend-date">${esc(fmtDate(v.date))}</span>
      </div>`;
    }).join("")}</div>` : `<div class="trend-empty">No visits recorded for this outlet.</div>`}`;

}

function setTrendToggle() {
  // Retained as the central visibility hook for existing async callbacks. The
  // old toggle card is gone; the Trend panel is now permanently visible.
  const panel = $("trend-panel");
  if (panel) panel.hidden = false;
}

let trendWired = false;
function wireTrendControls() {
  if (trendWired) return;
  trendWired = true;
  $("trend-file")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file || !window.TrendSource) return;
    try {
      const built = await window.TrendSource.fromFile(file);
      const payload = window.TrendSource.toPayload(built, built.fileName, built.sourceSignature);
      if (!payload) throw new Error("The Trend workbook has no usable visit rows.");
      adoptTrendPayload(payload);
      trendState.driveSignature = built.sourceSignature || "";
      trendState.error = "";
      saveTrendCache();
    } catch (error) {
      trendState.error = error?.message || String(error);
    }
    setTrendToggle();
    renderTrend();
  });
}

// Accept both the standalone visit-trend snapshot and the legacy
// dashboard_data.json `trend` property. The shape check prevents a Visit
// Compliance outlet directory from ever being mistaken for trend rows.
function unpackTrendPayload(raw) {
  const candidates = [raw?.data, raw?.trend, raw];
  for (const candidate of candidates) {
    const outlets = candidate?.outlets;
    if (!outlets || typeof outlets !== "object" || Array.isArray(outlets)) continue;
    if (!Object.values(outlets).some(entry => Array.isArray(entry?.visits))) continue;
    return {
      ...candidate,
      sourceSignature: candidate.sourceSignature || raw?.sourceSignature || "",
      generatedAt: candidate.generatedAt || raw?.generatedAt || "",
    };
  }
  return null;
}

function trendPayloadSignature(raw) {
  const payload = unpackTrendPayload(raw);
  if (!payload) return "";
  if (payload.sourceSignature) return `source:${payload.sourceSignature}|view:${TREND_RULE_VERSION}`;
  const codes = Object.keys(payload.outlets).sort();
  const visits = codes.map(code => {
    const rows = normalizeTrendVisits(payload.outlets[code]?.visits || []);
    return `${code}:${rows.map(row => `${row.date || ""},${row.score ?? ""},${row.max ?? ""},${row.percent ?? ""}`).join(";")}`;
  }).join("|");
  return `${TREND_RULE_VERSION}|${payload.fileName || ""}|${payload.maxScore || 0}|${visits}`;
}

// Takes a published trend payload and puts it only in trendState. Returns true
// when the chart changed; Visit Compliance state and Audit state are untouched.
function adoptTrendPayload(raw) {
  const published = unpackTrendPayload(raw);
  if (!published) return false;
  const normalized = {
    ...published,
    outlets: Object.fromEntries(Object.entries(published.outlets).map(([code, entry]) => [
      code,
      { ...entry, visits: normalizeTrendPayloadVisits(entry?.visits || [], published.sourceSignature) },
    ])),
  };
  const codes = Object.keys(normalized.outlets);
  const signature = trendPayloadSignature(normalized);
  trendState.published = normalized;
  if (!signature || signature === trendState.signature) return false;
  trendState.signature = signature;
  trendState.outlets = new Map(codes.map(code => [
    String(code).toUpperCase(),
    { name: normalized.outlets[code]?.name || "", visits: normalized.outlets[code]?.visits || [] },
  ]));
  trendState.fileName = normalized.fileName || "Trend workbook";
  trendState.sheet = normalized.sheet || "";
  trendState.maxScore = Number(normalized.maxScore) || 0;
  trendState.maxFromColumn = Boolean(normalized.maxFromColumn);
  trendState.error = "";
  return true;
}

async function loadTrend({ silent = true } = {}) {
  wireTrendControls();
  setTrendToggle();

  // The shared snapshot carries the trend for every viewer, including those with
  // no Google Drive access at all. It is checked on every data refresh, so a
  // newly published Trend workbook appears without a page reload.
  if (adoptTrendPayload(state.data?.trend || trendState.published)) {
    setTrendToggle();
    renderTrend();
    return;
  }
  if (trendState.outlets?.size) return;
  if (restoreTrendCache()) { setTrendToggle(); renderTrend(); }

  // The published copy is what every viewer gets, so it is checked before this
  // device's own Drive session. Without this, a viewer with no Drive folder saw
  // a Drive error flash into the box before the published chart arrived.
  await pollPublishedTrend();
  if (trendState.outlets?.size) return;
  const Trend = window.TrendSource;
  if (!Trend) { trendState.error = "trend-source.js is not loaded"; setTrendToggle(); return; }
  try {
    const drive = window.ShwapnoDrive;
    if (!drive) throw new Error("Drive module not available on this page");
    if (drive.getFolder && !drive.getFolder()) throw new Error("no Trend data published yet");
    // Strictly passive: the trend never triggers a Google sign-in. It rides on
    // the session the dashboard has already established; if there is none, it
    // waits quietly and the minute timer tries again.
    if (drive.cachedToken && !drive.cachedToken()) {
      throw new Error("open the box and press Connect Google Drive");
    }
    await loadTrendFromDrive();
    if (!trendState.outlets?.size) throw new Error("no file named Trend in the connected folder");
  } catch (error) {
    trendState.error = error?.message || String(error);
    console.warn("Trend workbook not loaded:", trendState.error);
    setTrendToggle();
    renderTrend();
  }
}

// Re-reads only the published trend every minute, so a newly uploaded Trend
// workbook appears without a page refresh and without any Drive connection.
// Nothing else in the payload is touched, so no other figure can change here.
const TREND_POLL_MS = 60000;
let trendPollStarted = false;

// Keeps the last successful read on this device, so the chart survives reloads
// and token expiry. One Drive session is enough; after that it just works.
function saveTrendCache() {
  try {
    if (!trendState.outlets?.size) return;
    localStorage.setItem(TREND_CACHE_KEY, JSON.stringify({
      fileName: trendState.fileName,
      sheet: trendState.sheet || "",
      maxScore: trendState.maxScore || 0,
      maxFromColumn: Boolean(trendState.maxFromColumn),
      sourceSignature: trendState.published?.sourceSignature || trendState.driveSignature || "",
      publishedSignature: trendState.publishedSignature || "",
      savedAt: Date.now(),
      outlets: Object.fromEntries([...trendState.outlets].map(([code, o]) => [code, o])),
    }));
  } catch { /* storage full or blocked - not fatal */ }
}

function restoreTrendCache() {
  try {
    const raw = localStorage.getItem(TREND_CACHE_KEY);
    if (!raw) return false;
    const cached = JSON.parse(raw);
    const entries = Object.entries(cached?.outlets || {});
    if (!entries.length) return false;
    trendState.outlets = new Map(entries.map(([code, o]) => [
      String(code).toUpperCase(), {
        name: o.name || "",
        visits: normalizeTrendPayloadVisits(o.visits || [], cached.sourceSignature),
      },
    ]));
    trendState.fileName = cached.fileName || "Trend workbook";
    trendState.sheet = cached.sheet || "";
    trendState.maxScore = Number(cached.maxScore) || 0;
    trendState.maxFromColumn = Boolean(cached.maxFromColumn);
    trendState.driveSignature = cached.sourceSignature || "";
    trendState.publishedSignature = cached.publishedSignature || "";
    trendState.signature = trendPayloadSignature({
      fileName: trendState.fileName,
      sheet: trendState.sheet,
      maxScore: trendState.maxScore,
      maxFromColumn: trendState.maxFromColumn,
      sourceSignature: trendState.driveSignature,
      outlets: cached.outlets,
    });
    trendState.error = "";
    return true;
  } catch { return false; }
}

async function publishTrendSnapshot(payload, sourceSignature) {
  if (!payload?.outlets || !Object.keys(payload.outlets).length) return false;
  const signature = sourceSignature || payload.sourceSignature || trendPayloadSignature(payload);
  if (signature && signature === trendState.publishedSignature) return true;
  try {
    const result = await publishIfSignedIn(TREND_CLOUD_SNAPSHOT_KEY, {
      version: 1,
      generatedAt: new Date().toISOString(),
      sourceSignature: signature,
      data: { ...payload, sourceSignature: signature },
    });
    if (!result?.published) return false;
    trendState.publishedSignature = signature;
    saveTrendCache();
    return true;
  } catch (error) {
    console.warn("Trend snapshot publish failed:", error);
    return false;
  }
}

async function loadTrendFromDrive() {
  if (trendDriveLoadPromise) return await trendDriveLoadPromise;
  const run = async () => {
    const Trend = window.TrendSource;
    const drive = window.ShwapnoDrive;
    if (!Trend || !drive?.listFolderFiles || !drive?.downloadFile) return null;
    try {
      const files = await drive.listFolderFiles();
      // Trend is isolated. Detection is by the exact workbook name, never by
      // sheet similarity or by the ordering of other Drive files.
      const meta = Trend.pickTrendFile(files);
      if (!meta) {
        if (!trendState.outlets?.size) trendState.error = "no file named Trend in the connected folder";
        return null;
      }

      const rawSignature = typeof drive.remoteSignature === "function"
        ? drive.remoteSignature(meta)
        : [meta.id || "", meta.name || "", meta.size || "", meta.modifiedTime || ""].join("|");
      const signature = trendRuleSignature(rawSignature);

      // A cached parse can be published immediately after the source PC signs
      // in, without downloading or recalculating the compliance dashboard.
      if (signature === trendState.driveSignature && trendState.outlets?.size) {
        const cachedPayload = Trend.toPayload({
          outlets: trendState.outlets,
          sheetName: trendState.sheet,
          maxScore: trendState.maxScore,
          maxFromColumn: trendState.maxFromColumn,
          sourceSignature: signature,
        }, trendState.fileName || meta.name, signature);
        await publishTrendSnapshot(cachedPayload, signature);
        return cachedPayload;
      }

      const built = await Trend.fromDrive(drive, files);
      if (!built?.outlets?.size) throw new Error("Trend has no usable visit rows.");
      const payload = Trend.toPayload(built, built.fileName || meta.name, signature);
      if (!payload) throw new Error("Trend has no usable visit rows.");

      trendState.driveSignature = signature;
      adoptTrendPayload(payload);
      trendState.error = "";
      saveTrendCache();
      setTrendToggle();
      renderTrend();

      // This is a separate snapshot key. Publishing Trend cannot replace or
      // modify the Visit Compliance or Audit snapshots.
      await publishTrendSnapshot(payload, trendState.driveSignature);
      return payload;
    } catch (error) {
      if (!trendState.outlets?.size) trendState.error = error?.message || String(error);
      console.warn("Trend Drive load failed:", error);
      setTrendToggle();
      renderTrend();
      return null;
    }
  };
  trendDriveLoadPromise = run();
  try {
    return await trendDriveLoadPromise;
  } finally {
    trendDriveLoadPromise = null;
  }
}

async function pollPublishedTrend() {
  // Primary source: the isolated Supabase row written by the source PC. Every
  // viewer can read it without Drive permission, exactly like other snapshots.
  try {
    const row = await readCloudSnapshot(TREND_CLOUD_SNAPSHOT_KEY);
    const cloudTrend = unpackTrendPayload(row?.payload);
    if (cloudTrend) {
      trendState.publishedSignature = cloudTrend.sourceSignature
        || row?.payload?.sourceSignature
        || trendPayloadSignature(cloudTrend);
      const changed = adoptTrendPayload(cloudTrend);
      saveTrendCache();
      if (changed) { setTrendToggle(); renderTrend(); }
      return;
    }
  } catch { /* Use the retained and repository fallbacks below. */ }

  // Compatibility with an older combined Visit snapshot.
  if (state.data?.trend?.outlets && Object.keys(state.data.trend.outlets).length) {
    if (adoptTrendPayload(state.data.trend)) { setTrendToggle(); renderTrend(); }
    return;
  }

  // Final fallback: a Trend workbook uploaded to the GitHub repository's data
  // folder is still embedded by build.py in dashboard_data.json.
  try {
    const res = await fetch(`data/dashboard_data.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return;
    const fresh = (await res.json())?.trend;
    if (!adoptTrendPayload(fresh)) return;
    saveTrendCache();
    setTrendToggle();
    renderTrend();
  } catch { /* Offline or mid-deploy — try again next minute. */ }
}

function startTrendPolling() {
  if (trendPollStarted) return;
  trendPollStarted = true;
  const tick = () => {
    pollPublishedTrend();
    // Drive is the live source for the raw workbooks, so re-read it too.
    if (window.ShwapnoDrive?.cachedToken?.()) loadTrendFromDrive();
  };
  tick();
  setInterval(() => { if (!document.hidden) tick(); }, TREND_POLL_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pollPublishedTrend(); });
}

function scoreClass(v) {
  const n = Number(v) || 0;
  if (n >= 80) return "good";
  if (n >= 50) return "mid";
  return "bad";
}

function renderTable(rows) {
  const head = $("performance-head");
  head.innerHTML = TABLE_COLUMNS.map(([key, label]) => {
    const indicator = state.sortKey === key ? (state.sortDir === 1 ? "▲" : "▼") : "↕";
    return `<th data-key="${key}">${esc(label)} <span class="sort">${indicator}</span></th>`;
  }).join("");
  head.querySelectorAll("th").forEach(th => th.addEventListener("click", () => {
    const key = th.dataset.key;
    if (state.sortKey === key) state.sortDir *= -1;
    else {
      state.sortKey = key;
      state.sortDir = key === "completionPct" ? -1 : -1;
    }
    render();
  }));

  const sorted = sortedOfficerRows(rows);
  $("performance-body").innerHTML = sorted.map(r => {
    const completionLabel = pct(r.completionPct);
    return `<tr class="${state.activeView?.officerKey === r.officerKey ? "selected-row" : ""}">
      <td><button type="button" class="officer-link" data-officer="${esc(r.officerKey)}">${esc(r.officer)}</button></td>
      <td><button type="button" class="metric-btn" data-metric="planned" data-officer="${esc(r.officerKey)}">${numberFmt.format(r.planned)}</button></td>
      <td><button type="button" class="metric-btn" data-metric="completed" data-officer="${esc(r.officerKey)}">${numberFmt.format(r.completed)}</button></td>
      <td><button type="button" class="metric-btn" data-metric="pending" data-officer="${esc(r.officerKey)}">${numberFmt.format(r.pending)}</button></td>
      <td><button type="button" class="metric-btn metric-chip ${scoreClass(r.completionPct)}" data-metric="completion" data-officer="${esc(r.officerKey)}">${completionLabel}</button></td>
    </tr>`;
  }).join("");

  $("performance-body").querySelectorAll(".officer-link").forEach(btn => btn.addEventListener("click", () => showView({ type: "officer", officerKey: btn.dataset.officer, metric: "all" })));
  $("performance-body").querySelectorAll(".metric-btn").forEach(btn => btn.addEventListener("click", () => showView({ type: "officer", officerKey: btn.dataset.officer, metric: btn.dataset.metric })));

  const planned = total(rows, "totalPlannedTillDate");
  const completed = totalCompleted(rows);
  const pending = total(rows, "remainingVisits");
  $("summary-caption").textContent = `${rows.length} officer rows in view · Planned (Till Date): ${numberFmt.format(planned)} · Completed: ${numberFmt.format(completed)} · Pending: ${numberFmt.format(pending)} · Click any metric to drill down`;
}

function getOutletMeta(siteCode) {
  return (state.data.outlets && state.data.outlets[siteCode]) || {};
}

function parseTime(value) {
  if (!value) return null;
  const str = String(value).trim();
  const m = str.match(/^(\d{1,2}):(\d{2})(?:\s*([AP]M))?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const mins = Number(m[2]);
  const mer = m[3] ? m[3].toUpperCase() : null;
  if (mer === "PM" && h < 12) h += 12;
  if (mer === "AM" && h === 12) h = 0;
  return h * 60 + mins;
}
function durationLabel(inTime, outTime) {
  const start = parseTime(inTime);
  const end = parseTime(outTime);
  if (start == null || end == null || end < start) return "—";
  const mins = end - start;
  return `${mins} min`;
}
function timeFlag(inTime, outTime) {
  if (!inTime || !outTime || inTime === "—" || outTime === "—") return "flag-missing";
  const start = parseTime(inTime), end = parseTime(outTime);
  if (start == null || end == null || end < start) return "flag-missing";
  if ((end - start) < 5) return "flag-short";
  return "flag-ok";
}
function statusClass(status) {
  const s = String(status || "").toLowerCase();
  if (s.includes("extra")) return "status-extra";
  if (s.includes("never")) return "status-never";
  if (s.includes("pending")) return "status-pending";
  return "status-completed";
}

function plannedMap(detail) {
  const map = new Map();
  (detail.plannedDateResponseList || []).forEach(r => map.set(`${r.siteCode}|${r.responseDate}`, r));
  return map;
}
function findPlanDateForSite(detail, siteCode) {
  const due = (detail.planned || []).filter(p => p.plannedDate <= state.data.metadata.snapshotDate && p.siteCode === siteCode);
  if (!due.length) return "";
  due.sort((a, b) => String(a.plannedDate).localeCompare(String(b.plannedDate)));
  return due[0].plannedDate;
}

function buildOfficerRows(officerRow, metric = "all") {
  const detail = state.data.details[officerRow.officerKey] || { planned: [], plannedDateResponseList: [], otherUnplannedResponseList: [], neverVisited: [] };
  const duePlans = (detail.planned || []).filter(p => !state.data.metadata.snapshotDate || p.plannedDate <= state.data.metadata.snapshotDate);
  const respMap = plannedMap(detail);

  const plannedRows = duePlans.map(p => {
    const match = respMap.get(`${p.siteCode}|${p.plannedDate}`);
    const inTime = match?.inTime || "—";
    const outTime = match?.outTime || "—";
    return {
      officerKey: officerRow.officerKey,
      officer: officerRow.officer,
      outletCode: p.siteCode,
      outletName: p.outletName || getOutletMeta(p.siteCode).outletName || "",
      plannedVisitDate: p.plannedDate,
      visitStatus: match ? "Completed" : "Pending",
      inTime,
      outTime,
      visitDuration: durationLabel(inTime, outTime),
      actualVisitDate: match?.responseDate || "",
      responseId: match?.responseId || "",
      remarks: match ? "Planned-date response" : "Pending visit"
    };
  });

  const extraRows = (detail.otherUnplannedResponseList || []).map(r => {
    const inTime = r.inTime || "—";
    const outTime = r.outTime || "—";
    return {
      officerKey: officerRow.officerKey,
      officer: officerRow.officer,
      outletCode: r.siteCode,
      outletName: r.outletName || getOutletMeta(r.siteCode).outletName || "",
      plannedVisitDate: "",
      visitStatus: "Completed (Extra)",
      inTime,
      outTime,
      visitDuration: durationLabel(inTime, outTime),
      actualVisitDate: r.responseDate || "",
      responseId: r.responseId || "",
      remarks: "Other / unplanned response"
    };
  });

  const neverRows = (detail.neverVisited || []).map(r => ({
    officerKey: officerRow.officerKey,
    officer: officerRow.officer,
    outletCode: r.siteCode,
    outletName: r.outletName || getOutletMeta(r.siteCode).outletName || "",
    plannedVisitDate: findPlanDateForSite(detail, r.siteCode),
    visitStatus: "Never Visited",
    inTime: "—",
    outTime: "—",
    visitDuration: "—",
    actualVisitDate: "",
    responseId: "",
    remarks: NEVER_VISITED_REMARK
  }));

  switch (metric) {
    case "planned": return plannedRows;
    case "completed": return [...plannedRows.filter(r => r.visitStatus === "Completed"), ...extraRows];
    case "pending": return plannedRows.filter(r => r.visitStatus === "Pending");
    case "completion": return [...plannedRows, ...extraRows];
    case "never": return neverRows;
    case "all":
    default: return [...plannedRows, ...extraRows];
  }
}

function aggregateRows(metric, rows) {
  let list = [];
  rows.forEach(r => { list = list.concat(buildOfficerRows(r, metric === "never" ? "never" : metric)); });
  return list;
}

function metricTitle(metric) {
  return ({
    planned: "Planned Visits (Till Date)",
    completed: "Completed Visits (Till Date)",
    pending: "Pending Visits",
    never: "Never Visited Outlets",
    completion: "Visit Completion %",
    all: "Officer Performance"
  }[metric] || "Visit Details");
}

function showView(view) {
  state.activeView = view;
  state.detailRemark = ALL_REMARKS;
  state.detailOutletCodeSearch = "";
  state.detailOutletNameSearch = "";
  render();
  requestAnimationFrame(() => $("details-section")?.scrollIntoView({ behavior: "smooth", block: "start" }));
}

function summaryPills(officerRows, metric) {
  const planned = total(officerRows, "totalPlannedTillDate");
  const completed = totalCompleted(officerRows);
  const pending = total(officerRows, "remainingVisits");
  const completion = planned ? ((completed / planned) * 100) : null;
  const pills = [
    { metric: "planned", label: "Planned Visits (Till Date)", value: numberFmt.format(planned) },
    { metric: "completed", label: "Completed", value: numberFmt.format(completed) },
    { metric: "pending", label: "Pending", value: numberFmt.format(pending) },
    { metric: "completion", label: "Completion", value: completion == null ? "—" : `${completion.toFixed(1)}%` },
  ];
  if (metric === "never") {
    pills.unshift({ metric: "never", label: "Never Visited", value: numberFmt.format(distinctNeverOutlets(officerRows)) });
  }
  return pills;
}

function detailRemarkOptions(rows) {
  return [...new Set([
    ...rows.map(row => row.remarks || "No remarks"),
    NEVER_VISITED_REMARK,
  ])].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function rowsForDetailRemark(rows, neverVisitedRows, remark) {
  if (remark === ALL_REMARKS) return rows;
  if (remark === NEVER_VISITED_REMARK) return neverVisitedRows;
  return rows.filter(row => (row.remarks || "No remarks") === remark);
}

function rowsForDetailSearch(rows) {
  const codeSearch = lower(state.detailOutletCodeSearch).trim();
  const nameSearch = lower(state.detailOutletNameSearch).trim();
  return rows.filter(row =>
    (!codeSearch || lower(row.outletCode).includes(codeSearch))
    && (!nameSearch || lower(row.outletName).includes(nameSearch))
  );
}

function bindDetailSearch(currentRows, inputId, stateKey) {
  const input = $(inputId);
  input?.addEventListener("input", event => {
    state[stateKey] = event.target.value;
    const selectionStart = event.target.selectionStart;
    const selectionEnd = event.target.selectionEnd;
    renderDetails(currentRows);
    const nextInput = $(inputId);
    nextInput?.focus({ preventScroll: true });
    if (selectionStart != null && selectionEnd != null) {
      nextInput?.setSelectionRange(selectionStart, selectionEnd);
    }
  });
}

function renderDetails(currentRows) {
  const target = $("details-section");
  if (!state.activeView) {
    target.innerHTML = `<div class="details-message">Click a headline KPI, officer name, or officer metric to see the management drill-down with In Time, Out Time, Visit Duration, Actual Visit Date, Response ID and Remarks.</div>`;
    return;
  }

  let title = "";
  let rows = [];
  let neverVisitedRows = [];
  let summaryOfficerRows = currentRows;
  let metric = state.activeView.metric || "all";
  if (state.activeView.type === "aggregate") {
    rows = aggregateRows(metric, currentRows);
    neverVisitedRows = aggregateRows("never", currentRows);
    title = metricTitle(metric);
  } else {
    const officer = currentRows.find(r => r.officerKey === state.activeView.officerKey);
    if (!officer) {
      target.innerHTML = `<div class="details-message">Officer not found in the current filtered set.</div>`;
      return;
    }
    rows = buildOfficerRows(officer, metric);
    neverVisitedRows = buildOfficerRows(officer, "never");
    summaryOfficerRows = [officer];
    title = metric === "all" ? `${officer.officer} Performance` : `${officer.officer} — ${metricTitle(metric)}`;
  }

  const summary = summaryPills(summaryOfficerRows, metric);
  const remarkOptions = detailRemarkOptions(rows);
  if (state.detailRemark !== ALL_REMARKS && !remarkOptions.includes(state.detailRemark)) {
    state.detailRemark = ALL_REMARKS;
  }
  const visibleRows = rowsForDetailSearch(rowsForDetailRemark(rows, neverVisitedRows, state.detailRemark));
  const visibleTitle = state.detailRemark === NEVER_VISITED_REMARK && metric !== "never"
    ? `${title} — Never Visited Outlets`
    : title;
  target.innerHTML = `
    <div class="details-header">
      <div class="details-title">
        <div>
          <h2>${esc(visibleTitle)}</h2>
          <p class="panel-caption">Outlet-level drill-down with attendance timing. Missing punches are highlighted in red; very short visits are highlighted in amber.</p>
        </div>
        <div class="details-actions">
          <button type="button" id="details-download" class="btn secondary">Download this detail</button>
          <button type="button" id="details-close" class="btn secondary">Close details</button>
        </div>
      </div>
      <div class="details-summary" aria-label="Choose detail section">${summary.map(item => `<button type="button" class="summary-pill${metric === item.metric ? " is-active" : ""}" data-detail-metric="${esc(item.metric)}" aria-pressed="${metric === item.metric ? "true" : "false"}">${esc(item.label)}: ${esc(item.value)}</button>`).join("")}</div>
    </div>
    ${renderDetailTable(visibleRows, remarkOptions)}`;

  $("details-close").addEventListener("click", () => { state.activeView = null; state.detailRemark = ALL_REMARKS; render(); });
  $("details-download").addEventListener("click", () => downloadDetailCsv(visibleRows, visibleTitle));
  target.querySelectorAll("[data-detail-metric]").forEach(button => button.addEventListener("click", () => {
    state.activeView = { ...state.activeView, metric: button.dataset.detailMetric };
    state.detailRemark = ALL_REMARKS;
    render();
  }));
  $("detail-remarks-filter")?.addEventListener("change", event => {
    state.detailRemark = event.target.value;
    renderDetails(currentRows);
  });
  bindDetailSearch(currentRows, "detail-outlet-code-search", "detailOutletCodeSearch");
  bindDetailSearch(currentRows, "detail-outlet-name-search", "detailOutletNameSearch");
}

function renderDetailTable(rows, remarkOptions = []) {
  if (!rows.length && !remarkOptions.length) return `<div class="details-message">No records found for this drill-down in the current selection.</div>`;
  const body = rows.map(r => {
    const flag = timeFlag(r.inTime, r.outTime);
    return `<tr>
      <td>${esc(r.outletCode)}</td>
      <td>${esc(r.outletName)}</td>
      <td>${esc(r.officer)}</td>
      <td>${r.plannedVisitDate ? esc(fmtDate(r.plannedVisitDate)) : "—"}</td>
      <td><span class="visit-status ${statusClass(r.visitStatus)}">${esc(r.visitStatus)}</span></td>
      <td class="${flag}">${esc(r.inTime || "—")}</td>
      <td class="${flag}">${esc(r.outTime || "—")}</td>
      <td class="${flag}">${esc(r.visitDuration || "—")}</td>
      <td>${r.actualVisitDate ? esc(fmtDate(r.actualVisitDate)) : "—"}</td>
      <td>${esc(r.responseId || "—")}</td>
      <td>${esc(r.remarks || "")}</td>
    </tr>`;
  }).join("");

  return `<div class="detail-table-wrap"><table class="detail-table"><thead><tr>
      <th><label class="remarks-heading detail-search-heading" style="min-width:126px"><span>Outlet Code</span><input id="detail-outlet-code-search" type="search" autocomplete="off" placeholder="Search code" value="${esc(state.detailOutletCodeSearch)}" aria-label="Search detail rows by outlet code" style="min-height:36px;border-radius:10px;padding:0 10px;font-size:12px;font-weight:700"></label></th>
      <th><label class="remarks-heading detail-search-heading" style="min-width:180px"><span>Outlet Name</span><input id="detail-outlet-name-search" type="search" autocomplete="off" placeholder="Search name" value="${esc(state.detailOutletNameSearch)}" aria-label="Search detail rows by outlet name" style="min-height:36px;border-radius:10px;padding:0 10px;font-size:12px;font-weight:700"></label></th>
      <th>Officer</th>
      <th>Planned Visit Date</th>
      <th>Visit Status</th>
      <th>In Time</th>
      <th>Out Time</th>
      <th>Visit Duration</th>
      <th>Actual Visit Date</th>
      <th>Response ID</th>
      <th><label class="remarks-heading"><span>Remarks</span><select id="detail-remarks-filter" aria-label="Filter detail rows by remarks"><option value="${ALL_REMARKS}">All remarks</option>${remarkOptions.map(remark => `<option value="${esc(remark)}"${state.detailRemark === remark ? " selected" : ""}>${esc(remark)}</option>`).join("")}</select></label></th>
    </tr></thead><tbody>${body || `<tr><td colspan="11" class="detail-empty-row">No records match the current detail filters.</td></tr>`}</tbody></table></div>`;
}

function renderDefinitions() {
  const d = state.data.definitions;
  const parts = [
    `<strong>Planned Visits (Till Date):</strong> ${esc(d.tillDate)}`,
    `<strong>Completed Visits (Till Date):</strong> ${esc(d.completed)} ${esc(d.other || "")}`,
    `<strong>Pending Visits:</strong> ${esc(d.remaining)}`,
    `<strong>Never Visited Outlets:</strong> ${esc(d.neverVisited)}`,
    `<strong>Visit Completion %:</strong> ${esc(d.completion)}`
  ];
  $("definitions-text").innerHTML = parts.map(p => `<p>${p}</p>`).join("");
  const m = state.data.metadata;
  const surveyFooter = m.surveyReportUrl ? ` · <a href="${esc(m.surveyReportUrl)}" target="_blank" rel="noopener noreferrer">Survey reports</a>` : "";
  $("source-footer").innerHTML = `Data source: ${esc(m.scheduleFile)} + ${esc(m.responseFile)} · Generated ${esc(new Date(m.generatedAt).toLocaleString())}${surveyFooter}`;
}

function csvEscape(v) { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; }
function downloadCsv() {
  const rows = sortedOfficerRows(getOfficerRowsFiltered());
  const header = ["Officer", "Status", "Planned Visits (Till Date)", "Completed Visits (Till Date)", "Pending Visits", "Visit Completion %"];
  const lines = [header.map(csvEscape).join(",")];
  rows.forEach(r => {
    lines.push([
      r.officer,
      r.status,
      r.planned,
      r.completed,
      r.pending,
      pct(r.completionPct)
    ].map(csvEscape).join(","));
  });
  saveCsv(lines, "visible_visit_compliance.csv");
}
function downloadDetailCsv(rows, title) {
  const header = ["Outlet Code", "Outlet Name", "Officer", "Planned Visit Date", "Visit Status", "In Time", "Out Time", "Visit Duration", "Actual Visit Date", "Response ID", "Remarks"];
  const lines = [header.map(csvEscape).join(",")];
  rows.forEach(r => lines.push([
    r.outletCode,
    r.outletName,
    r.officer,
    r.plannedVisitDate ? fmtDate(r.plannedVisitDate) : "",
    r.visitStatus,
    r.inTime,
    r.outTime,
    r.visitDuration,
    r.actualVisitDate ? fmtDate(r.actualVisitDate) : "",
    r.responseId,
    r.remarks
  ].map(csvEscape).join(",")));
  const safe = title.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase();
  saveCsv(lines, `${safe || 'visit_detail'}.csv`);
}
function saveCsv(lines, filename) {
  const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

const OUTLET_LIMIT = 40;
function outletList() { return state.data?.outlets ? Object.values(state.data.outlets) : []; }
function matchingOutlets(term) {
  const q = term.trim().toLowerCase();
  if (!q) return [];
  const hits = outletList().filter(o => lower(o.siteCode).includes(q) || lower(o.outletName).includes(q));
  hits.sort((a, b) => {
    const ac = lower(a.siteCode).startsWith(q) ? 0 : 1;
    const bc = lower(b.siteCode).startsWith(q) ? 0 : 1;
    if (ac !== bc) return ac - bc;
    return String(a.outletName || a.siteCode).localeCompare(String(b.outletName || b.siteCode));
  });
  return hits;
}
function renderOutletResults() {
  const box = $("outlet-results");
  if (!box) return;
  const term = state.outletSearch || "";
  if (state.selectedOutlet || !term.trim()) { box.innerHTML = ""; box.hidden = true; return; }
  box.hidden = false;
  const hits = matchingOutlets(term);
  if (!hits.length) {
    box.innerHTML = `<div class="outlet-empty">No outlet matches “${esc(term)}”. Try a code such as D062 or part of the outlet name.</div>`;
    return;
  }
  box.innerHTML = hits.slice(0, OUTLET_LIMIT).map(o => `<button class="outlet-hit" type="button" data-code="${esc(o.siteCode)}"><span class="hit-name">${esc(o.outletName || '(name not in schedule)')}</span><span class="hit-code">${esc(o.siteCode)}</span></button>`).join("");
  box.querySelectorAll(".outlet-hit").forEach(btn => btn.addEventListener("click", () => selectOutlet(btn.dataset.code)));
}
function visitCell(label, iso, who, inTime, outTime) {
  const value = iso ? `${esc(fmtDate(iso))}${who ? `<span class="by">by ${esc(who)}</span>` : ""}${inTime || outTime ? `<span class="by">In time: ${esc(inTime || 'Missing')} · Out time: ${esc(outTime || 'Missing')}</span>` : ""}` : `Not visited yet`;
  return `<div class="outlet-cell"><dt>${esc(label)}</dt><dd class="${iso ? '' : 'none'}">${value}</dd></div>`;
}
function auditScoreCell(siteCode) {
  const code = String(siteCode || "").trim().toUpperCase();
  const audit = state.auditScores.get(code);
  if (!audit) {
    const message = state.auditScoreStatus === "loading" ? "Loading latest audit…" : "No scored audit found";
    return `<div class="outlet-cell audit-score-cell"><dt>Audit score</dt><dd class="none">${esc(message)}</dd></div>`;
  }
  const score = pct(audit.score);
  const points = `${numberFmt.format(audit.earned)} / ${numberFmt.format(audit.available)} points`;
  return `<div class="outlet-cell audit-score-cell"><dt>Audit score</dt><dd>
    <a class="audit-score-link ${scoreClass(audit.score)}" href="./audit.html?outlet=${encodeURIComponent(code)}" target="_blank" rel="noopener noreferrer" aria-label="Open Audit Command Dashboard for outlet ${esc(code)} in a new tab">${esc(score)}</a>
    <span class="by">${esc(points)} · click score for outlet audit</span>
  </dd></div>`;
}
function renderOutletCard() {
  const card = $("outlet-card");
  const outlet = state.selectedOutlet ? state.data.outlets?.[state.selectedOutlet] : null;
  if (!card) return;
  if (!outlet) { card.hidden = true; card.innerHTML = ""; return; }
  card.hidden = false;
  card.innerHTML = `
    <div class="outlet-card-head">
      <h2>${esc(outlet.outletName || 'Outlet')} <span class="code-chip">${esc(outlet.siteCode)}</span></h2>
      <button class="outlet-card-close" type="button" id="outlet-card-close">Clear</button>
    </div>
    <dl class="outlet-grid">
      <div class="outlet-cell"><dt>Outlet code</dt><dd>${esc(outlet.siteCode)}</dd></div>
      <div class="outlet-cell"><dt>Outlet name</dt><dd class="${outlet.outletName ? '' : 'none'}">${esc(outlet.outletName || 'Not in schedule')}</dd></div>
      <div class="outlet-cell"><dt>Zonal</dt><dd class="${outlet.zonalName ? '' : 'none'}">${esc(outlet.zonalName || 'Not assigned')}</dd></div>
      <div class="outlet-cell"><dt>Regional (RHO)</dt><dd class="${outlet.rhoName ? '' : 'none'}">${esc(outlet.rhoName || 'Not assigned')}</dd></div>
      ${visitCell('Last visit', outlet.lastVisit, outlet.lastVisitBy)}
      ${visitCell('Last visit by Zonal', outlet.lastVisitZonal, outlet.lastVisitZonalBy, outlet.lastVisitZonalInTime, outlet.lastVisitZonalOutTime)}
      ${visitCell('Last visit by Regional (RHO)', outlet.lastVisitRho, outlet.lastVisitRhoBy, outlet.lastVisitRhoInTime, outlet.lastVisitRhoOutTime)}
      ${auditScoreCell(outlet.siteCode)}
    </dl>`;
  $("outlet-card-close").addEventListener("click", () => {
    state.selectedOutlet = null;
    state.outletSearch = "";
    state.officerKey = ALL_OFFICERS;
    state.activeView = null;
    state.detailRemark = ALL_REMARKS;
    $("outlet-search").value = "";
    updateOfficerOptions();
    render();
    $("outlet-search")?.focus();
  });
}
function selectOutlet(code) {
  const outlet = state.data.outlets?.[code];
  if (!outlet) return;
  state.selectedOutlet = code;
  state.outletSearch = `${outlet.outletName || "Outlet"} (${outlet.siteCode})`;
  state.status = "All statuses";
  state.officerKey = ALL_OFFICERS;
  state.search = "";
  state.activeView = null;
  state.detailRemark = ALL_REMARKS;
  $("outlet-search").value = state.outletSearch;
  $("status-filter").value = state.status;
  $("officer-search").value = "";
  updateOfficerOptions();
  render();
  requestAnimationFrame(() => $("outlet-card")?.scrollIntoView({ behavior: "smooth", block: "start" }));
}

function reconcileActiveView(rows) {
  if (!state.activeView || state.activeView.type !== "officer") return;
  if (rows.some(row => row.officerKey === state.activeView.officerKey)) return;
  state.activeView = null;
  state.detailRemark = ALL_REMARKS;
}

function activeOfficerRow(rows) {
  if (state.activeView?.type !== "officer") return null;
  return rows.find(row => row.officerKey === state.activeView.officerKey) || null;
}

function clearOfficerSelection() {
  state.officerKey = ALL_OFFICERS;
  state.activeView = null;
  state.detailRemark = ALL_REMARKS;
  const officerFilter = $("officer-filter");
  if (officerFilter) officerFilter.value = ALL_OFFICERS;
  render();
}

function render() {
  const rows = getOfficerRowsFiltered();
  reconcileActiveView(rows);
  const activeOfficer = activeOfficerRow(rows);
  const clearOfficer = $("clear-officer-selection");
  if (clearOfficer) clearOfficer.hidden = !activeOfficer && state.officerKey === ALL_OFFICERS;
  renderKpis(activeOfficer ? [activeOfficer] : rows, activeOfficer?.officerKey || null);
  renderTable(rows);
  renderDetails(rows);
  renderOutletResults();
  renderOutletCard();
  renderTrend();
  scheduleDashboardAutoFit();
}

function applyDataLoad(nextLoad) {
  state.dataLoad = nextLoad;
  state.data = nextLoad.data;
  const statuses = new Set(["All statuses", ...state.data.officers.map(r => r.status)]);
  if (!statuses.has(state.status)) state.status = "All statuses";
  if (!state.data.officers.some(r => r.officerKey === state.officerKey)) state.officerKey = ALL_OFFICERS;
  if (state.selectedOutlet && !state.data.outlets?.[state.selectedOutlet]) state.selectedOutlet = null;
  renderHeader();
  $("status-filter").value = state.status;
  renderDefinitions();
  renderReconciliation(state.data?.metadata);
  loadTrend();
  startTrendPolling();
  render();
}


function bindDriveSetupModalFix() {
  const modal = document.getElementById("drive-modal");
  const openBtn = document.getElementById("drive-setup");
  const closeBtn = document.getElementById("drive-modal-close");
  const clearBtn = document.getElementById("drive-clear");
  const saveBtn = document.getElementById("drive-save");

  const hideModal = () => {
    if (modal) modal.hidden = true;
  };
  const showModal = () => {
    if (modal) modal.hidden = false;
    try {
      const c = window.ShwapnoDrive?.getConfig?.() || {};
      const folder = window.ShwapnoDrive?.getFolder?.() || {};
      const client = document.getElementById("google-client-id");
      const key = document.getElementById("google-api-key");
      const app = document.getElementById("google-app-id");
      if (client) client.value = c.clientId || "";
      if (key) key.value = c.apiKey || "";
      if (app) app.value = c.appId || "";
    } catch {}
  };

  openBtn?.addEventListener("click", showModal);
  closeBtn?.addEventListener("click", hideModal);

  saveBtn?.addEventListener("click", async () => {
    try {
      saveBtn.disabled = true;
      const config = {
        clientId: document.getElementById("google-client-id")?.value.trim() || "",
        apiKey: document.getElementById("google-api-key")?.value.trim() || "",
        appId: document.getElementById("google-app-id")?.value.trim() || ""
      };
      if (!window.ShwapnoDrive) throw new Error("Google Drive module is not loaded.");
      window.ShwapnoDrive.saveConfig(config);
      const result = await window.ShwapnoDrive.connect({
        pickFolder: true,
        title: "Select shared Shwapno dashboard data folder"
      });
      if (result?.folder) {
        window.ShwapnoDrive.saveFolder(result.folder);
        hideModal();
        window.dispatchEvent(new CustomEvent("shwapno-drive-connected", {detail: result.folder}));
        location.reload();
      }
    } catch (err) {
      alert(err.message || "Google Drive setup failed.");
    } finally {
      saveBtn.disabled = false;
    }
  });

  clearBtn?.addEventListener("click", () => {
    window.ShwapnoDrive?.clearSetup?.();
    hideModal();
    location.reload();
  });
}

async function init() {
  installDashboardAutoFit();
  bindDriveSetupModalFix();
  try {
    const auditScorePromise = loadAuditScores().catch(() => ({ scores: new Map(), source: "" }));
    state.dataLoad = await loadDashboardData();
    state.data = state.dataLoad.data;
    renderHeader();
    renderDefinitions();
  renderReconciliation(state.data?.metadata);
    render();
    // First paint has to read the trend too. Previously only a later Google
    // Drive refresh did, so anyone who simply opened the page never got the
    // chart and the box stayed on "Trend workbook not read yet".
    loadTrend();
    startTrendPolling();

    auditScorePromise.then(result => {
      state.auditScores = result.scores;
      state.auditScoreSource = result.source;
      state.auditScoreStatus = result.scores.size ? "ready" : "unavailable";
      renderOutletCard();
    });

    $("status-filter").addEventListener("change", e => {
      state.status = e.target.value;
      state.activeView = null;
      state.detailRemark = ALL_REMARKS;
      updateOfficerOptions();
      render();
    });
    $("officer-filter").addEventListener("change", e => {
      state.officerKey = e.target.value;
      state.detailRemark = ALL_REMARKS;
      state.detailOutletCodeSearch = "";
      state.detailOutletNameSearch = "";
      state.activeView = state.officerKey === ALL_OFFICERS
        ? null
        : { type: "officer", officerKey: state.officerKey, metric: "all" };
      render();
    });
    $("officer-search").addEventListener("input", e => {
      state.search = e.target.value;
      state.activeView = null;
      state.detailRemark = ALL_REMARKS;
      render();
    });
    $("reset-btn").addEventListener("click", () => {
      state.status = "All statuses";
      state.officerKey = ALL_OFFICERS;
      state.search = "";
      state.activeView = null;
      state.detailRemark = ALL_REMARKS;
      state.outletSearch = "";
      state.selectedOutlet = null;
      $("status-filter").value = state.status;
      $("officer-search").value = "";
      $("outlet-search").value = "";
      updateOfficerOptions();
      render();
    });
    $("download-btn").addEventListener("click", downloadCsv);
    $("clear-officer-selection").addEventListener("click", clearOfficerSelection);
    $("theme-toggle").addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      try { localStorage.setItem(THEME_KEY, next); } catch {}
      applyTheme(next);
    });
    $("outlet-search").addEventListener("input", e => {
      const nextSearch = e.target.value;
      if (state.selectedOutlet && nextSearch !== state.outletSearch) {
        state.selectedOutlet = null;
        state.officerKey = ALL_OFFICERS;
        state.activeView = null;
        state.detailRemark = ALL_REMARKS;
        updateOfficerOptions();
      }
      state.outletSearch = nextSearch;
      render();
    });
    document.querySelectorAll(".view-tab").forEach(btn => btn.addEventListener("click", () => {
      document.querySelectorAll(".view-tab").forEach(x => x.classList.remove("is-active"));
      btn.classList.add("is-active");
      const target = document.querySelector(btn.dataset.scroll);
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
    }));

    attachGoogleDriveDataSource(state.dataLoad.localSource, {
      baseData: state.data,
      onData: applyDataLoad,
      onStatus: localStatus => {
        state.dataLoad = { ...state.dataLoad, localStatus };
        renderDataSource();
      },
    });
  } catch (err) {
    const owner = window.DashboardDriveOwner?.isOwner?.();
    const detail = owner ? err.message : "The latest published dashboard data could not be loaded.";
    const guidance = owner ? "Use Drive setup to connect the shared Google Drive folder containing Store_Operations_Compliance_Audit_responses." : "No published snapshot is currently available.";
    $("main-content").innerHTML = `<div class="error-box"><strong>Dashboard could not load.</strong>\n${esc(detail)}\n\n${esc(guidance)}</div>`;
  }
}
init();
