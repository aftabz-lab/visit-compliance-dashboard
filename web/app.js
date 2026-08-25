import { attachGoogleDriveDataSource, getDataStatus, loadDashboardData } from "./data-loader.js?v=visit-interactions-v2";
import { readCloudSnapshot } from "./supabase-sync.js?v=visit-compliance-v12-supabase";

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

  const cards = [
    { id: "completion", tone: "success", label: "Visit Completion %", value: completion == null ? "—" : `${completion.toFixed(1)}%`, meta: "Completed visits ÷ planned visits (till date)" },
    { id: "pending", tone: "danger", label: "Pending Visits", value: numberFmt.format(pending), meta: "No response yet" },
    { id: "never", tone: "warning", label: "Never Visited Outlets", value: numberFmt.format(never), meta: "Till date" },
    { id: "planned", tone: "info", label: "Planned Visits (Till Date)", value: numberFmt.format(planned), meta: "Visits scheduled up to the snapshot date" },
    { id: "completed", tone: "success", label: "Completed Visits (Till Date)", value: numberFmt.format(completed), meta: "Completed planned visits + extra / unplanned responses" },
    { id: "accepted", tone: "info", label: "Accepted Responses", value: numberFmt.format(total(rows, "acceptedResponses")), meta: "Survey responses accepted from the workbook" }
  ];

  $("kpis").innerHTML = cards.map(card => `
    <div class="kpi-card" data-tone="${card.tone}" data-kpi-card="${card.id}">
      <div class="kpi-label">${card.label}</div>
      <button type="button" class="kpi-action" data-kpi="${card.id}">${card.value}</button>
      <div class="kpi-meta">${card.meta}</div>
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
const trendState = { outlets: null, fileName: "", code: "", error: "", open: false };

function trendTone(v, max) {
  const share = max > 0 ? v / max : 0;
  if (share >= 0.85) return "#3fb27f";
  if (share >= 0.7) return "#8cc152";
  if (share >= 0.5) return "#e0a53f";
  return "#d9534f";
}

function renderTrend() {
  const panel = $("trend-panel");
  if (!panel) return;
  panel.hidden = !trendState.open;

  // No Trend workbook yet: say so plainly and offer to open one directly,
  // rather than leaving an empty space with no explanation.
  if (!trendState.outlets || !trendState.outlets.size) {
    panel.innerHTML = `
      <div class="panel-head"><h2>Visit score trend</h2>
        <p class="panel-caption">Last ${window.TrendSource ? window.TrendSource.LAST_N : 6} visits per outlet</p></div>
      <div class="trend-empty">${!trendState.outlets ? "" : `No rows for <b>${esc(state.selectedOutlet || "")}</b> in the Trend workbook.<br>`}${trendState.error
        ? `Could not read the Trend workbook: ${esc(trendState.error)}`
        : "No workbook named <b>Trend</b> was found in the connected Google Drive folder."}</div>
      <div class="trend-pick"><button type="button" id="trend-open">Open the Trend workbook</button></div>`;
    $("trend-open")?.addEventListener("click", () => $("trend-file")?.click());
    return;
  }

  const codes = [...trendState.outlets.keys()].sort();
  trendState.code = state.selectedOutlet ? String(state.selectedOutlet).toUpperCase() : codes[0];
  const entry = trendState.outlets.get(trendState.code);
  const visits = entry?.visits || [];
  const max = Math.max(1, ...visits.map(v => v.score));

  panel.innerHTML = `
    <div class="panel-head"><h2>Visit score trend</h2>
      <p class="panel-caption">Last ${window.TrendSource.LAST_N} visits · from ${esc(trendState.fileName || "Trend workbook")}</p></div>
    <div class="trend-controls">
      <b style="font-size:12.5px">${esc(trendState.code)}${entry?.name ? " · " + esc(entry.name) : ""}</b>
      <span class="trend-note">${codes.length.toLocaleString()} outlets in ${esc(trendState.fileName || "the Trend file")}</span>
    </div>
    ${visits.length ? `<div class="trend-chart">${visits.map(v => {
      const h = Math.max(4, Math.round(140 * v.score / max));
      return `<div class="trend-col">
        <span class="trend-val" style="color:${trendTone(v.score, max)}">${v.score}</span>
        <span class="trend-bar-wrap"><span class="trend-bar" style="height:${h}px;background:${trendTone(v.score, max)}"></span></span>
        <span class="trend-date">${esc(fmtDate(v.date))}</span>
      </div>`;
    }).join("")}</div>` : `<div class="trend-empty">No visits recorded for this outlet.</div>`}`;

}

function setTrendToggle() {
  const btn = $("trend-toggle");
  if (!btn) return;
  // Only meaningful once an outlet is picked, so it stays faded until then.
  const code = state.selectedOutlet ? String(state.selectedOutlet).toUpperCase() : "";
  btn.disabled = !code;
  if (!code) { trendState.open = false; const p = $("trend-panel"); if (p) p.hidden = true; }
  btn.setAttribute("aria-expanded", String(Boolean(trendState.open)));
  const chev = $("trend-chev");
  if (chev) chev.textContent = trendState.open ? "▴" : "▾";
  const note = $("trend-toggle-note");
  if (note) {
    note.textContent = !code
      ? "At first select any outlet"
      : trendState.outlets?.size
        ? `${code} · last ${window.TrendSource ? window.TrendSource.LAST_N : 6} visits`
        : `${code} · Trend workbook not loaded yet`;
  }
}

function wireTrendControls() {
  $("trend-toggle")?.addEventListener("click", () => {
    trendState.open = !trendState.open;
    setTrendToggle();
    renderTrend();
  });
  $("trend-file")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file || !window.TrendSource) return;
    try {
      const built = await window.TrendSource.fromFile(file);
      trendState.outlets = built.outlets;
      trendState.fileName = built.fileName;
      trendState.error = "";
    } catch (error) {
      trendState.error = error?.message || String(error);
    }
    setTrendToggle();
    renderTrend();
  });
}

async function loadTrend() {
  wireTrendControls();
  setTrendToggle();
  const Trend = window.TrendSource;
  if (!Trend) return;
  try {
    const drive = window.GoogleDriveSource;
    const built = drive ? await Trend.fromDrive(drive) : null;
    if (built?.outlets?.size) {
      trendState.outlets = built.outlets;
      trendState.fileName = built.fileName;
      setTrendToggle();
      renderTrend();
    }
  } catch (error) {
    trendState.error = error?.message || String(error);
    console.warn("Trend workbook not loaded:", trendState.error);
    setTrendToggle();
    renderTrend();
  }
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
  const visibleRows = rowsForDetailRemark(rows, neverVisitedRows, state.detailRemark);
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
      <th>Outlet Code</th>
      <th>Outlet Name</th>
      <th>Officer</th>
      <th>Planned Visit Date</th>
      <th>Visit Status</th>
      <th>In Time</th>
      <th>Out Time</th>
      <th>Visit Duration</th>
      <th>Actual Visit Date</th>
      <th>Response ID</th>
      <th><label class="remarks-heading"><span>Remarks</span><select id="detail-remarks-filter" aria-label="Filter detail rows by remarks"><option value="${ALL_REMARKS}">All remarks</option>${remarkOptions.map(remark => `<option value="${esc(remark)}"${state.detailRemark === remark ? " selected" : ""}>${esc(remark)}</option>`).join("")}</select></label></th>
    </tr></thead><tbody>${body || `<tr><td colspan="11" class="detail-empty-row">No records match this remark.</td></tr>`}</tbody></table></div>`;
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
    <a class="audit-score-link ${scoreClass(audit.score)}" href="./audit.html?outlet=${encodeURIComponent(code)}" aria-label="Open Audit Command Dashboard for outlet ${esc(code)}">${esc(score)}</a>
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
  setTimeout(() => { setTrendToggle(); renderTrend(); }, 0);
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
  bindDriveSetupModalFix();
  try {
    const auditScorePromise = loadAuditScores().catch(() => ({ scores: new Map(), source: "" }));
    state.dataLoad = await loadDashboardData();
    state.data = state.dataLoad.data;
    renderHeader();
    renderDefinitions();
  renderReconciliation(state.data?.metadata);
    render();

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
