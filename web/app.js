import { attachPcRawDataSource, getDataStatus, loadDashboardData } from "./data-loader.js?v=pc-response-dashboard-plan-v11-shared-snapshot";

const columns = [
  ["status", "Status"],
  ["officer", "Officer"],
  ["totalPlannedFullMonth", "Total Planned Visits (Full Month)"],
  ["totalPlannedTillDate", "Total Planned Visits (Till Date)"],
  ["acceptedResponses", "Accepted Responses"],
  ["plannedDateResponses", "Planned-Date Responses"],
  ["otherUnplannedResponses", "Other / Unplanned Responses"],
  ["distinctPlannedVisitsCompleted", "Distinct Planned Visits Completed"],
  ["remainingVisits", "Remaining Visits (No Response)"],
  ["neverVisitedOutlets", "Never Visited Outlets (Till Date)"],
  ["completionPct", "Completion %"]
];
const ALL_OFFICERS = "__ALL_OFFICERS__";
const state = { data: null, dataLoad: null, outletSearch: "", selectedOutlet: null, status: "All statuses", officerKey: ALL_OFFICERS, search: "", sortKey: "status", sortDir: 1, activeDetailTab: "planned", activeKpi: null, drillSortKey: null, drillSortDir: 1 };
const $ = id => document.getElementById(id);
const numberFmt = new Intl.NumberFormat("en-US");
function fmtDate(iso) { return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day:"2-digit", month:"short", year:"numeric", timeZone:"UTC" }); }
function fmtSnapshotTimestamp(value) {
  const timestamp = value ? new Date(value) : null;
  if (!timestamp || Number.isNaN(timestamp.getTime())) return "not available";
  return timestamp.toLocaleString("en-US", {
    day: "numeric", month: "short", year: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
    timeZone: "Asia/Dhaka",
  });
}
function esc(v) { return String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
function pct(v) { return v == null || Number.isNaN(Number(v)) ? "—" : `${Number(v).toFixed(1)}%`; }
function getFiltered() {
  const q = state.search.trim().toLowerCase();
  return state.data.officers.filter(r => {
    if (state.status !== "All statuses" && r.status !== state.status) return false;
    if (state.officerKey !== ALL_OFFICERS && r.officerKey !== state.officerKey) return false;
    if (q && !r.officer.toLowerCase().includes(q)) return false;
    return true;
  });
}
function sortedRows(rows) {
  const key = state.sortKey, dir = state.sortDir;
  return [...rows].sort((a,b) => {
    const av=a[key], bv=b[key];
    if (av == null && bv == null) return 0; if (av == null) return 1; if (bv == null) return -1;
    if (typeof av === "number" || typeof bv === "number") return (Number(av)-Number(bv))*dir;
    return String(av).localeCompare(String(bv), undefined, { sensitivity:"base" })*dir;
  });
}
function updateOfficerOptions() {
  const previous = state.officerKey;
  const source = state.data.officers
    .filter(r => state.status === "All statuses" || r.status === state.status)
    .sort((a,b) => a.officer.localeCompare(b.officer, undefined, { sensitivity:"base" }) || a.status.localeCompare(b.status));
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
function scrollToDetails() {
  requestAnimationFrame(() => $("details-section")?.scrollIntoView({ behavior:"smooth", block:"start" }));
}
function selectOfficer(officerKey, scroll = true) {
  state.officerKey = officerKey || ALL_OFFICERS;
  state.activeDetailTab = "planned";
  updateOfficerOptions();
  $("officer-filter").value = state.officerKey;
  render();
  if (scroll && state.officerKey !== ALL_OFFICERS) scrollToDetails();
}
function renderHeader() {
  const m = state.data.metadata;
  document.title = m.title;
  $("page-title").textContent = m.title;
  $("subtitle").textContent = m.subtitle;
  const hasLocalSnapshot = Boolean(m.snapshotDate && state.data.officers.length);
  $("snapshot-line").textContent = hasLocalSnapshot
    ? `Response snapshot through ${fmtDate(m.snapshotDate)}`
    : "PC raw-data folder required";
  $("snapshot-note").textContent = hasLocalSnapshot
    ? `Till-date plans are due through this date; full-month plans cover all of ${m.reportMonth}.`
    : "Choose the PC raw-data folder containing Store_Operations_Compliance_Audit_responses. A Visit Schedule workbook is optional in that folder.";
  renderDataSource();
  const statuses = ["All statuses", ...new Set(state.data.officers.map(r=>r.status))];
  $("status-filter").innerHTML = statuses.map(v=>`<option>${esc(v)}</option>`).join("");
  updateOfficerOptions();
}

function renderDataSource() {
  const m = state.data.metadata || {};
  const dataLoad = state.dataLoad || {};
  const source = dataLoad.source || "awaiting-local";
  const localStatus = dataLoad.localStatus || {};
  const isPcFolder = source === "pc-folder";
  const isPcFolderSelection = source === "pc-folder-selection";
  const isPcFile = source === "pc-file";
  const isSavedCopy = source === "local-cache";
  const isPublishedShared = source === "published-shared";
  const isWaiting = source === "awaiting-local";
  const responseSheet = m.responseSheet || "Response Summary";
  const acceptedResponses = Number(m.diagnostics?.acceptedResponses);
  const snapshotTakenAt = m.snapshotTakenAt || m.generatedAt || dataLoad.lastFetched;

  $("data-source-badge").textContent = isPcFolder
    ? "PC FOLDER — LIVE"
    : isPcFolderSelection
      ? "PC FOLDER — LOADED"
      : isPcFile
        ? "PC FILE — LIVE"
        : isSavedCopy
          ? "RETAINED SNAPSHOT"
          : isPublishedShared
            ? "SHARED SNAPSHOT"
            : "PC FOLDER REQUIRED";
  $("data-source-badge").classList.toggle("is-saved-copy", isSavedCopy || isPublishedShared);
  $("data-source-file").textContent = isWaiting
    ? "Choose your PC raw-data folder"
    : m.responseFile || "Response workbook";
  $("data-source-sheet").textContent = `Sheet: ${responseSheet} only`;
  $("data-source-count").textContent = isWaiting
    ? "Waiting for selected PC raw-data folder"
    : Number.isFinite(acceptedResponses)
    ? `${numberFmt.format(acceptedResponses)} accepted responses`
    : "Accepted response total unavailable";
  $("data-source-taken").textContent = snapshotTakenAt && !isWaiting
    ? `Snapshot taken ${fmtSnapshotTimestamp(snapshotTakenAt)}`
    : "Snapshot not yet taken";
  $("data-source-note").textContent = isPublishedShared
    ? `${localStatus.message || getDataStatus(dataLoad).text} The shared copy was originally created from a PC raw-data workbook named like “Store_Operations_Compliance_Audit_responses…xlsx”, using only “${responseSheet}”.`
    : `${localStatus.message || getDataStatus(dataLoad).text} The response source must be a local file named like “Store_Operations_Compliance_Audit_responses…xlsx”; only “${responseSheet}” is read.`;
  const grantButton = $("grant-folder");
  if (grantButton) grantButton.hidden = localStatus.kind !== "needs-grant";
  const fallbackButton = $("pick-folder-fallback-btn");
  if (fallbackButton && localStatus.kind === "needs-folder-fallback") fallbackButton.hidden = false;
}
function distinctNeverOutlets(rows) {
  const set = new Set();
  rows.forEach(r => (state.data.details[r.officerKey]?.neverVisited || []).forEach(x => set.add(x.siteCode)));
  return set.size;
}
function renderKpis(rows) {
  const visibleOfficers = rows.filter(r => state.data.metadata.includeUnmappedInVisibleOfficerKpi || r.status !== "Unmapped").length;
  const total = key => rows.reduce((t,r)=>t+(Number(r[key])||0),0);
  const till = total("totalPlannedTillDate");
  const completed = total("distinctPlannedVisitsCompleted");
  const otherUnplanned = total("otherUnplannedResponses");
  const remaining = total("remainingVisits");
  const neverDistinct = distinctNeverOutlets(rows);
  const remainingPct = till ? (remaining / till * 100) : null;
  const completionPct = till ? ((completed + otherUnplanned) / till * 100) : null;

  const cards = [
    ["visibleOfficers", "Visible Officers", visibleOfficers, ""],
    ["fullMonth", "Total Planned Visits<br>(Full Month)", total("totalPlannedFullMonth"), ""],
    ["tillDate", "Planned Visits<br>Till Date", till, ""],
    ["accepted", "Accepted<br>Responses", total("acceptedResponses"), ""],
    ["completed", "Planned Visits<br>Completed", completed, ""],
    ["remaining", "Remaining Visits<br>(No Response)", remaining, remainingPct === null ? "" : `${remainingPct.toFixed(1)}%`],
    ["never", "Never Visited<br>Outlets Till Date", neverDistinct, ""],
    ["otherUnplanned", "Other / Unplanned<br>Response List (Till Date)", otherUnplanned, ""],
    ["completion", "Completion<br>%", completionPct === null ? "—" : `${completionPct.toFixed(1)}%`, ""]
  ];

  $("kpis").innerHTML = cards.map(([id,label,value,smallPct]) => {
    const mainValue = typeof value === "number" ? numberFmt.format(value) : value;
    const pctHtml = smallPct
      ? `<span class="kpi-inline-pct" title="Remaining Visits as % of Planned Visits Till Date">(${smallPct})</span>`
      : "";
    const active = state.activeKpi === id ? " kpi-link-active" : "";
    return `<div class="kpi-card"><div class="kpi-label">${label}</div><div class="kpi-value"><button type="button" class="kpi-link${active}" data-kpi="${id}" title="Click to list outlet code, outlet name, RHO name and zonal name">${mainValue}</button>${pctHtml}</div></div>`;
  }).join("");
  $("kpis").querySelectorAll(".kpi-link").forEach(btn => btn.addEventListener("click", () => showKpiDrill(btn.dataset.kpi)));
}

const KPI_TITLES = {
  visibleOfficers: "Visible Officers",
  fullMonth: "Total Planned Visits (Full Month)",
  tillDate: "Planned Visits Till Date",
  accepted: "Accepted Responses",
  completed: "Planned Visits Completed",
  remaining: "Remaining Visits (No Response)",
  never: "Never Visited Outlets (Till Date)",
  otherUnplanned: "Other / Unplanned Response List (Till Date)",
  completion: "Completion basis — Planned Visits Completed + Other / Unplanned Responses"
};
const DRILL_COLUMNS = [["siteCode","Outlet Code"],["outletName","Outlet Name"],["rhoName","RHO Name"],["zonalName","Zonal Name"]];
function outletMeta(siteCode, fallbackName) {
  const o = (state.data.outlets && state.data.outlets[siteCode]) || {};
  return {
    siteCode: siteCode || "",
    outletName: fallbackName || o.outletName || "",
    rhoName: o.rhoName || "",
    zonalName: o.zonalName || ""
  };
}
function kpiOutletRecords(kpiId, rows) {
  const snapshot = state.data.metadata.snapshotDate;
  const det = k => state.data.details[k] || {};
  const keys = rows.map(r => r.officerKey);
  const collect = picker => keys.flatMap(k => picker(det(k)) || []);
  const toOutlet = list => list.map(x => outletMeta(x.siteCode, x.outletName));
  switch (kpiId) {
    case "fullMonth": return toOutlet(collect(d => d.planned));
    case "tillDate": return toOutlet(collect(d => (d.planned || []).filter(p => p.plannedDate <= snapshot)));
    case "completed": return toOutlet(collect(d => d.completed));
    case "remaining": return toOutlet(collect(d => d.remaining));
    case "never": {
      const seen = new Set();
      const uniq = [];
      for (const x of collect(d => d.neverVisited)) {
        if (!seen.has(x.siteCode)) { seen.add(x.siteCode); uniq.push(x); }
      }
      return toOutlet(uniq);
    }
    case "accepted": return toOutlet(collect(d => [...(d.plannedDateResponseList || []), ...(d.otherUnplannedResponseList || [])]));
    case "otherUnplanned": return toOutlet(collect(d => d.otherUnplannedResponseList));
    case "completion": return toOutlet([...collect(d => d.completed), ...collect(d => d.otherUnplannedResponseList)]);
    default: return [];
  }
}
function showKpiDrill(kpiId) {
  state.activeKpi = kpiId;
  state.drillSortKey = null;
  state.drillSortDir = 1;
  render();
  requestAnimationFrame(() => $("kpi-drill-section")?.scrollIntoView({ behavior:"smooth", block:"start" }));
}
function drillDataset(kpiId, rows) {
  if (kpiId === "visibleOfficers") {
    const inc = state.data.metadata.includeUnmappedInVisibleOfficerKpi;
    return {
      cols: [["status","Status"],["officer","Officer"],["totalPlannedTillDate","Planned Visits Till Date","num"],["completionPct","Completion %","pct"]],
      records: rows.filter(r => inc || r.status !== "Unmapped"),
      extraClass: "kpi-drill-officers"
    };
  }
  return { cols: DRILL_COLUMNS, records: kpiOutletRecords(kpiId, rows), extraClass: "" };
}
function sortDrillRows(records, cols) {
  const key = state.drillSortKey;
  if (!key) return records;
  const col = cols.find(c => c[0] === key);
  const numeric = !!(col && col[2] === "num");
  const dir = state.drillSortDir;
  return [...records].sort((a,b) => {
    let av = a[key], bv = b[key];
    if (numeric || (col && col[2] === "pct")) {
      av = (av == null || av === "") ? null : Number(av);
      bv = (bv == null || bv === "") ? null : Number(bv);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * dir;
    }
    return String(av ?? "").localeCompare(String(bv ?? ""), undefined, { numeric:true, sensitivity:"base" }) * dir;
  });
}
function drillTableHtml(cols, records, extraClass) {
  const sorted = sortDrillRows(records, cols);
  const headRow = cols.map(([k,label]) => {
    const ind = state.drillSortKey === k ? (state.drillSortDir === 1 ? "▲" : "▼") : "↕";
    return `<th data-sort-key="${esc(k)}" title="Sort by ${esc(label)}">${esc(label)} <span class="sort">${ind}</span></th>`;
  }).join("");
  const bodyRows = sorted.map(r => `<tr>${cols.map(([k,,type]) => {
    let cell;
    if (type === "pct") cell = pct(r[k]);
    else if (type === "num") cell = numberFmt.format(Number(r[k]) || 0);
    else cell = esc(r[k]);
    return `<td>${cell}</td>`;
  }).join("")}</tr>`).join("");
  return `<div class="detail-table-wrap"><table class="detail-table kpi-drill-table ${extraClass}"><thead><tr>${headRow}</tr></thead><tbody>${bodyRows}</tbody></table></div>`;
}
function renderKpiDrill(rows) {
  const target = $("kpi-drill-section");
  if (!target) return;
  const kpiId = state.activeKpi;
  if (!kpiId) { target.innerHTML = ""; return; }
  const title = KPI_TITLES[kpiId] || "Details";
  const head = `<div class="details-title kpi-drill-title"><span>Selected metric — ${esc(title)}</span><div class="kpi-drill-actions"><button type="button" id="kpi-drill-csv" class="btn secondary">Download this list</button><button type="button" id="kpi-drill-close" class="btn secondary">Close list</button></div></div>`;

  const { cols, records, extraClass } = drillDataset(kpiId, rows);
  const caption = kpiId === "visibleOfficers"
    ? `${records.length} officer(s) in view · click a column header to sort. Outlet-level columns (Outlet Code / Outlet Name / RHO Name / Zonal Name) appear for the outlet-based metrics.`
    : `${numberFmt.format(records.length)} row(s) listed · click a column header to sort.`;
  const body = records.length
    ? drillTableHtml(cols, records, extraClass)
    : `<div class="details-message">No records for this metric in the current selection.</div>`;
  target.innerHTML = `${head}<div class="kpi-drill-caption">${caption}</div>${body}`;

  target.querySelectorAll(".kpi-drill-table th[data-sort-key]").forEach(th => th.addEventListener("click", () => {
    const k = th.dataset.sortKey;
    if (state.drillSortKey === k) state.drillSortDir *= -1;
    else { state.drillSortKey = k; state.drillSortDir = 1; }
    renderKpiDrill(getFiltered());
  }));
  wireKpiDrillButtons(kpiId, rows);
}
function wireKpiDrillButtons(kpiId, rows) {
  $("kpi-drill-close")?.addEventListener("click", () => { state.activeKpi = null; render(); });
  $("kpi-drill-csv")?.addEventListener("click", () => downloadKpiDrillCsv(kpiId, rows));
}
function downloadKpiDrillCsv(kpiId, rows) {
  const { cols, records } = drillDataset(kpiId, rows);
  const sorted = sortDrillRows(records, cols);
  const header = cols.map(c => c[1]);
  const lines = sorted.map(r => cols.map(([k,,type]) => type === "pct" ? pct(r[k]) : (r[k] ?? "")));
  const out = [header.map(csvEscape).join(",")].concat(lines.map(row => row.map(csvEscape).join(",")));
  const blob = new Blob(["\ufeff"+out.join("\r\n")], { type:"text/csv;charset=utf-8" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = `${kpiId}_outlet_list.csv`; a.click(); URL.revokeObjectURL(a.href);
}
function renderTable(rows) {
  const head = $("performance-head");
  head.innerHTML = columns.map(([key,label]) => `<th data-key="${key}">${esc(label)} <span class="sort">${state.sortKey===key ? (state.sortDir===1?"▲":"▼") : "↕"}</span></th>`).join("");
  head.querySelectorAll("th").forEach(th => th.addEventListener("click", () => {
    const key=th.dataset.key; if (state.sortKey===key) state.sortDir*=-1; else { state.sortKey=key; state.sortDir=1; } render();
  }));
  const sorted = sortedRows(rows);
  $("performance-body").innerHTML = sorted.map(r => `<tr class="${state.officerKey===r.officerKey?"selected-row":""}">${columns.map(([key]) => {
    const val=r[key];
    if (key==="officer") return `<td class="officer-cell"><button type="button" class="officer-link" data-officer-key="${esc(r.officerKey)}" title="Show outlet details for ${esc(r.officer)}">${esc(val)}</button></td>`;
    if (key==="completionPct") return `<td>${pct(val)}</td>`;
    if (typeof val === "number") return `<td>${numberFmt.format(val)}</td>`;
    return `<td>${esc(val)}</td>`;
  }).join("")}</tr>`).join("");
  $("performance-body").querySelectorAll(".officer-link").forEach(btn => btn.addEventListener("click", () => {
    selectOfficer(btn.dataset.officerKey, true);
  }));
  const total = key => rows.reduce((t,r)=>t+(Number(r[key])||0),0);
  $("summary-caption").textContent = `${rows.length} displayed rows · ${numberFmt.format(total("totalPlannedFullMonth"))} planned visits full month · ${numberFmt.format(total("totalPlannedTillDate"))} planned visits till date · ${numberFmt.format(total("remainingVisits"))} remaining with no response · ${numberFmt.format(distinctNeverOutlets(rows))} distinct never visited outlets`;
}
function detailTable(rows, type) {
  if (!rows.length) return `<div class="details-message">No records in this section.</div>`;

  let cols;
  if (type === "never") {
    cols = [["siteCode","Outlet Code"],["outletName","Outlet Name"]];
  } else if (type === "plannedResponses" || type === "unplannedResponses") {
    cols = [["responseDate","Response Date"],["siteCode","Outlet Code"],["outletName","Outlet Name"],["responseId","Response ID"]];
  } else {
    cols = [["plannedDate","Planned Date"],["siteCode","Outlet Code"],["outletName","Outlet Name"]];
  }

  const dateKeys = new Set(["plannedDate","responseDate"]);
  return `<div class="detail-table-wrap"><table class="detail-table detail-table-${type}"><thead><tr>${cols.map(c=>`<th>${c[1]}</th>`).join("")}</tr></thead><tbody>${rows.map(r=>`<tr>${cols.map(([k])=>`<td>${dateKeys.has(k)&&r[k]?fmtDate(r[k]):esc(r[k])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function renderDetails(rows) {
  const target=$("details-section");
  if (rows.length!==1) {
    target.innerHTML=`<div class="details-message"><strong>Officer outlet details:</strong> Select an officer, or search until only one officer remains, to see planned outlets, remaining visits, never-visited outlets, planned-date response rows, and other/unplanned response rows through the snapshot.</div>`;
    return;
  }

  const row=rows[0];
  const d=state.data.details[row.officerKey] || {
    planned:[],
    remaining:[],
    neverVisited:[],
    plannedDateResponseList:[],
    otherUnplannedResponseList:[]
  };

  const plannedResponses = d.plannedDateResponseList || [];
  const unplannedResponses = d.otherUnplannedResponseList || [];

  const tabs=[
    ["planned",`Planned outlets (${d.planned.length})`],
    ["remaining",`Remaining visits (${d.remaining.length})`],
    ["never",`Never visited outlets (${d.neverVisited.length})`],
    ["plannedResponses",`Planned-date response list (${plannedResponses.length})`],
    ["unplannedResponses",`Other / unplanned response list (${unplannedResponses.length})`]
  ];

  const tabMap = {
    planned: d.planned,
    remaining: d.remaining,
    never: d.neverVisited,
    plannedResponses,
    unplannedResponses
  };
  const tabRows = tabMap[state.activeDetailTab] || d.planned;

  target.innerHTML=`<div class="details-title">Officer outlet details — ${esc(row.status)} · ${esc(row.officer)}</div><div class="tabs">${tabs.map(([k,l])=>`<button class="tab-btn ${state.activeDetailTab===k?"active":""}" data-tab="${k}">${l}</button>`).join("")}</div><div id="detail-content">${detailTable(tabRows,state.activeDetailTab)}</div>`;
  target.querySelectorAll(".tab-btn").forEach(b=>b.addEventListener("click",()=>{state.activeDetailTab=b.dataset.tab;renderDetails(rows);}));
}
function renderDefinitions() {
  const d=state.data.definitions;
  $("definitions-text").textContent = `${d.fullMonth} ${d.remaining} ${d.neverVisited} ${d.completion}`;
  const m=state.data.metadata;
  const unmapped=m.diagnostics.unmappedResponseNames?.length ? ` · Unmapped response names: ${m.diagnostics.unmappedResponseNames.join(", ")}` : "";
  const superseded = Array.isArray(m.supersededFiles) && m.supersededFiles.length
    ? ` · Ignoring older upload${m.supersededFiles.length > 1 ? "s" : ""}: ${m.supersededFiles.join(", ")}`
    : "";
  const dataStatus = state.dataLoad ? ` · ${getDataStatus(state.dataLoad).text}` : "";
  const surveyFooter = m.surveyReportUrl ? ` · <a href="${esc(m.surveyReportUrl)}" target="_blank" rel="noopener noreferrer">Survey reports</a>` : "";
  if (state.dataLoad?.source === "awaiting-local") {
    $("source-footer").textContent = "Data source: waiting for a PC raw-data folder. Repository dashboard data is not used.";
    return;
  }
  $("source-footer").innerHTML=`Data source: ${esc(m.scheduleFile)} + ${esc(m.responseFile)} · Generated ${esc(new Date(m.generatedAt).toLocaleString())}${esc(unmapped)}${esc(superseded)}${esc(dataStatus)}${surveyFooter}`;
}
function render() {
  const rows=getFiltered();
  renderKpis(rows); renderTable(rows); renderDetails(rows); renderKpiDrill(rows);
}
function csvEscape(v) { const s=String(v??""); return /[",\n]/.test(s)?`"${s.replaceAll('"','""')}"`:s; }
function downloadCsv() {
  const rows=sortedRows(getFiltered());
  const lines=[columns.map(c=>csvEscape(c[1])).join(",")];
  for (const r of rows) lines.push(columns.map(([k])=>csvEscape(k==="completionPct"?pct(r[k]):r[k])).join(","));
  const blob=new Blob(["\ufeff"+lines.join("\r\n")],{type:"text/csv;charset=utf-8"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="visible_visit_compliance.csv"; a.click(); URL.revokeObjectURL(a.href);
}
/* ── Outlet lookup ──────────────────────────────────────────────────────
   Search by outlet name or code, then show one card with the seven fields
   operations actually asks for: who owns the outlet and when it was last
   seen, split by Zonal and RHO. Data comes from data.outlets, built in
   scripts/build.py.                                                      */
const OUTLET_LIMIT = 40;

function outletList() {
  const outlets = state.data?.outlets;
  if (!outlets) return [];
  return Object.values(outlets);
}

function matchingOutlets(term) {
  const q = term.trim().toLowerCase();
  if (!q) return [];
  const hits = outletList().filter(o =>
    String(o.siteCode || "").toLowerCase().includes(q) ||
    String(o.outletName || "").toLowerCase().includes(q));
  // Code matches first, then name, both alphabetical - predictable ordering.
  hits.sort((a, b) => {
    const ac = String(a.siteCode || "").toLowerCase().startsWith(q) ? 0 : 1;
    const bc = String(b.siteCode || "").toLowerCase().startsWith(q) ? 0 : 1;
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
    box.innerHTML = `<p class="outlet-empty">No outlet matches “${esc(term)}”. Try a code such as D062, or part of the name.</p>`;
    return;
  }
  box.innerHTML = hits.slice(0, OUTLET_LIMIT).map(o => `
    <button class="outlet-hit" type="button" role="option"
            aria-selected="${state.selectedOutlet === o.siteCode ? "true" : "false"}"
            data-code="${esc(o.siteCode)}">
      <span class="hit-name">${esc(o.outletName || "(name not in schedule)")}</span>
      <span class="hit-code">${esc(o.siteCode)}</span>
    </button>`).join("") +
    (hits.length > OUTLET_LIMIT ? `<p class="outlet-empty">${hits.length - OUTLET_LIMIT} more match — keep typing to narrow.</p>` : "");
  box.querySelectorAll(".outlet-hit").forEach(btn =>
    btn.addEventListener("click", () => selectOutlet(btn.dataset.code)));
}

function visitCell(label, iso, who) {
  const value = iso
    ? `${esc(fmtDate(iso))}${who ? `<span class="by">by ${esc(who)}</span>` : ""}`
    : "Not visited yet";
  return `<div class="outlet-cell"><dt>${esc(label)}</dt><dd class="${iso ? "" : "none"}">${value}</dd></div>`;
}

function renderOutletCard() {
  const card = $("outlet-card");
  if (!card) return;
  const outlet = state.selectedOutlet ? state.data.outlets?.[state.selectedOutlet] : null;
  if (!outlet) { card.hidden = true; card.innerHTML = ""; return; }
  card.hidden = false;
  card.innerHTML = `
    <div class="outlet-card-head">
      <h2>${esc(outlet.outletName || "Outlet")} <span class="code-chip">${esc(outlet.siteCode)}</span></h2>
      <button class="outlet-card-close" type="button" id="outlet-card-close">Clear</button>
    </div>
    <dl class="outlet-grid">
      <div class="outlet-cell"><dt>Outlet code</dt><dd>${esc(outlet.siteCode)}</dd></div>
      <div class="outlet-cell"><dt>Outlet name</dt><dd class="${outlet.outletName ? "" : "none"}">${esc(outlet.outletName || "Not in schedule")}</dd></div>
      <div class="outlet-cell"><dt>Zonal</dt><dd class="${outlet.zonalName ? "" : "none"}">${esc(outlet.zonalName || "Not assigned")}</dd></div>
      <div class="outlet-cell"><dt>Regional (RHO)</dt><dd class="${outlet.rhoName ? "" : "none"}">${esc(outlet.rhoName || "Not assigned")}</dd></div>
      ${visitCell("Last visit", outlet.lastVisit, outlet.lastVisitBy)}
      ${visitCell("Last visit by Zonal", outlet.lastVisitZonal, outlet.lastVisitZonalBy)}
      ${visitCell("Last visit by Regional (RHO)", outlet.lastVisitRho, outlet.lastVisitRhoBy)}
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

function applyDataLoad(nextLoad) {
  state.dataLoad = nextLoad;
  state.data = nextLoad.data;
  const statuses = new Set(["All statuses", ...state.data.officers.map(row => row.status)]);
  if (!statuses.has(state.status)) state.status = "All statuses";
  if (!state.data.officers.some(row => row.officerKey === state.officerKey)) state.officerKey = ALL_OFFICERS;
  if (state.selectedOutlet && !state.data.outlets?.[state.selectedOutlet]) state.selectedOutlet = null;
  renderHeader();
  $("status-filter").value = state.status;
  renderDefinitions();
  render();
  renderOutletResults();
  renderOutletCard();
}

async function init() {
  try {
    state.dataLoad=await loadDashboardData();
    state.data=state.dataLoad.data;
    renderHeader(); renderDefinitions(); render();
    $("status-filter").addEventListener("change",e=>{state.status=e.target.value;updateOfficerOptions();render();});
    $("officer-filter").addEventListener("change",e=>selectOfficer(e.target.value, true));
    $("officer-search").addEventListener("input",e=>{state.search=e.target.value;render();});
    $("reset-btn").addEventListener("click",()=>{state.status="All statuses";state.officerKey=ALL_OFFICERS;state.search="";state.activeDetailTab="planned";state.activeKpi=null;$("status-filter").value=state.status;$("officer-search").value="";state.outletSearch="";state.selectedOutlet=null;$("outlet-search").value="";renderOutletResults();renderOutletCard();updateOfficerOptions();render();});
    $("download-btn").addEventListener("click",downloadCsv);
    $("outlet-search").addEventListener("input", e => { state.outletSearch = e.target.value; renderOutletResults(); });
    const rail = document.querySelector(".rail");
    $("rail-toggle").addEventListener("click", () => {
      const open = rail.classList.toggle("open");
      $("rail-toggle").setAttribute("aria-expanded", String(open));
    });
    attachPcRawDataSource(state.dataLoad.localSource, {
      baseData: state.data,
      onData: applyDataLoad,
      onStatus: (localStatus) => {
        state.dataLoad = { ...state.dataLoad, localStatus };
        renderDataSource();
      },
    });
  } catch(err) {
    document.querySelector("main").innerHTML=`<div class="error-box"><strong>Dashboard could not load.</strong>\n${esc(err.message)}\n\nUse Chrome or Edge, then choose the PC raw-data folder containing Store_Operations_Compliance_Audit_responses.</div>`;
  }
}
init();
