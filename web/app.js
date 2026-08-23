import { attachGoogleDriveDataSource, getDataStatus, loadDashboardData } from "./data-loader.js?v=visit-top-management-v1";

const ALL_OFFICERS = "__ALL_OFFICERS__";
const THEME_KEY = "visit-compliance-theme";
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

function getOfficerRowsFiltered() {
  const q = state.search.trim().toLowerCase();
  return state.data.officers.filter(r => {
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
  const source = state.data.officers
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

function renderKpis(rows) {
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
    { id: "completed", tone: "success", label: "Completed Visits (Till Date)", value: numberFmt.format(completed), meta: "Completed planned visits + extra / unplanned responses" }
  ];

  $("kpis").innerHTML = cards.map(card => `
    <div class="kpi-card" data-tone="${card.tone}">
      <div class="kpi-label">${card.label}</div>
      <button type="button" class="kpi-action" data-kpi="${card.id}">${card.value}</button>
      <div class="kpi-meta">${card.meta}</div>
    </div>`).join("");

  $("kpis").querySelectorAll(".kpi-action").forEach(btn => btn.addEventListener("click", () => showView({ type: "aggregate", metric: btn.dataset.kpi })));
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
    remarks: "No visit record till date"
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
  render();
  requestAnimationFrame(() => $("details-section")?.scrollIntoView({ behavior: "smooth", block: "start" }));
}

function summaryPills(rows, metric) {
  const planned = rows.filter(r => r.visitStatus !== "Completed (Extra)" && r.visitStatus !== "Never Visited").length;
  const completed = rows.filter(r => r.visitStatus === "Completed" || r.visitStatus === "Completed (Extra)").length;
  const pending = rows.filter(r => r.visitStatus === "Pending").length;
  const completion = planned ? ((completed / planned) * 100) : null;
  const pills = [];
  if (metric !== "never") pills.push(`Planned Visits (Till Date): ${numberFmt.format(planned)}`);
  pills.push(`Completed: ${numberFmt.format(completed)}`);
  if (metric !== "completed") pills.push(`Pending: ${numberFmt.format(pending)}`);
  if (metric === "never") pills.push(`Never Visited: ${numberFmt.format(rows.length)}`);
  if (metric === "completion" || metric === "all" || metric === "planned") pills.push(`Completion: ${completion == null ? "—" : `${completion.toFixed(1)}%`}`);
  return pills;
}

function renderDetails(currentRows) {
  const target = $("details-section");
  if (!state.activeView) {
    target.innerHTML = `<div class="details-message">Click a headline KPI, officer name, or officer metric to see the management drill-down with In Time, Out Time, Visit Duration, Actual Visit Date, Response ID and Remarks.</div>`;
    return;
  }

  let title = "";
  let rows = [];
  let metric = state.activeView.metric || "all";
  if (state.activeView.type === "aggregate") {
    rows = aggregateRows(metric, currentRows);
    title = metricTitle(metric);
  } else {
    const officer = state.data.officers.find(r => r.officerKey === state.activeView.officerKey);
    if (!officer) {
      target.innerHTML = `<div class="details-message">Officer not found in the current filtered set.</div>`;
      return;
    }
    rows = buildOfficerRows(officer, metric);
    title = metric === "all" ? `${officer.officer} Performance` : `${officer.officer} — ${metricTitle(metric)}`;
  }

  const summary = summaryPills(rows, metric);
  target.innerHTML = `
    <div class="details-header">
      <div class="details-title">
        <div>
          <h2>${esc(title)}</h2>
          <p class="panel-caption">Outlet-level drill-down with attendance timing. Missing punches are highlighted in red; very short visits are highlighted in amber.</p>
        </div>
        <div class="details-actions">
          <button type="button" id="details-download" class="btn secondary">Download this detail</button>
          <button type="button" id="details-close" class="btn secondary">Close details</button>
        </div>
      </div>
      <div class="details-summary">${summary.map(s => `<span class="summary-pill">${esc(s)}</span>`).join("")}</div>
    </div>
    ${renderDetailTable(rows)}`;

  $("details-close").addEventListener("click", () => { state.activeView = null; render(); });
  $("details-download").addEventListener("click", () => downloadDetailCsv(rows, title));
}

function renderDetailTable(rows) {
  if (!rows.length) return `<div class="details-message">No records found for this drill-down in the current selection.</div>`;
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
      <th>Remarks</th>
    </tr></thead><tbody>${body}</tbody></table></div>`;
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
  if (!term.trim()) { box.innerHTML = ""; return; }
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
    </dl>`;
  $("outlet-card-close").addEventListener("click", () => {
    state.selectedOutlet = null;
    renderOutletCard();
    renderOutletResults();
  });
}
function selectOutlet(code) {
  state.selectedOutlet = code;
  renderOutletCard();
  renderOutletResults();
  $("outlet-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function render() {
  const rows = getOfficerRowsFiltered();
  renderKpis(rows);
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
  render();
}

async function init() {
  try {
    state.dataLoad = await loadDashboardData();
    state.data = state.dataLoad.data;
    renderHeader();
    renderDefinitions();
    render();

    $("status-filter").addEventListener("change", e => { state.status = e.target.value; updateOfficerOptions(); render(); });
    $("officer-filter").addEventListener("change", e => { state.officerKey = e.target.value; render(); });
    $("officer-search").addEventListener("input", e => { state.search = e.target.value; render(); });
    $("reset-btn").addEventListener("click", () => {
      state.status = "All statuses";
      state.officerKey = ALL_OFFICERS;
      state.search = "";
      state.activeView = null;
      state.outletSearch = "";
      state.selectedOutlet = null;
      $("status-filter").value = state.status;
      $("officer-search").value = "";
      $("outlet-search").value = "";
      updateOfficerOptions();
      render();
    });
    $("download-btn").addEventListener("click", downloadCsv);
    $("theme-toggle").addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      try { localStorage.setItem(THEME_KEY, next); } catch {}
      applyTheme(next);
    });
    $("outlet-search").addEventListener("input", e => { state.outletSearch = e.target.value; renderOutletResults(); });
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
