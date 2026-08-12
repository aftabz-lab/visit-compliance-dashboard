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
const state = { data: null, status: "All statuses", officerKey: ALL_OFFICERS, search: "", sortKey: "status", sortDir: 1, activeDetailTab: "planned", activeKpi: null };
const $ = id => document.getElementById(id);
const numberFmt = new Intl.NumberFormat("en-US");
function fmtDate(iso) { return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day:"2-digit", month:"short", year:"numeric", timeZone:"UTC" }); }
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
  $("snapshot-line").textContent = `Response snapshot through ${fmtDate(m.snapshotDate)}`;
  $("snapshot-note").textContent = `Till-date plans are due through this date; full-month plans cover all of ${m.reportMonth}.`;
  const statuses = ["All statuses", ...new Set(state.data.officers.map(r=>r.status))];
  $("status-filter").innerHTML = statuses.map(v=>`<option>${esc(v)}</option>`).join("");
  updateOfficerOptions();
}
function renderKpis(rows) {
  const visibleOfficers = rows.filter(r => state.data.metadata.includeUnmappedInVisibleOfficerKpi || r.status !== "Unmapped").length;
  const total = key => rows.reduce((t,r)=>t+(Number(r[key])||0),0);
  const till = total("totalPlannedTillDate");
  const completed = total("distinctPlannedVisitsCompleted");
  const otherUnplanned = total("otherUnplannedResponses");
  const remaining = total("remainingVisits");
  const remainingPct = till ? (remaining / till * 100) : null;
  const completionPct = till ? ((completed + otherUnplanned) / till * 100) : null;

  const cards = [
    ["visibleOfficers", "Visible Officers", visibleOfficers, ""],
    ["fullMonth", "Total Planned Visits<br>(Full Month)", total("totalPlannedFullMonth"), ""],
    ["tillDate", "Planned Visits<br>Till Date", till, ""],
    ["accepted", "Accepted<br>Responses", total("acceptedResponses"), ""],
    ["completed", "Planned Visits<br>Completed", completed, ""],
    ["remaining", "Remaining Visits<br>(No Response)", remaining, remainingPct === null ? "" : `${remainingPct.toFixed(1)}%`],
    ["never", "Never Visited<br>Outlets Till Date", total("neverVisitedOutlets"), ""],
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
    case "never": return toOutlet(collect(d => d.neverVisited));
    case "accepted": return toOutlet(collect(d => [...(d.plannedDateResponseList || []), ...(d.otherUnplannedResponseList || [])]));
    case "otherUnplanned": return toOutlet(collect(d => d.otherUnplannedResponseList));
    case "completion": return toOutlet([...collect(d => d.completed), ...collect(d => d.otherUnplannedResponseList)]);
    default: return [];
  }
}
function showKpiDrill(kpiId) {
  state.activeKpi = kpiId;
  render();
  requestAnimationFrame(() => $("kpi-drill-section")?.scrollIntoView({ behavior:"smooth", block:"start" }));
}
function renderKpiDrill(rows) {
  const target = $("kpi-drill-section");
  if (!target) return;
  const kpiId = state.activeKpi;
  if (!kpiId) { target.innerHTML = ""; return; }
  const title = KPI_TITLES[kpiId] || "Details";
  const head = `<div class="details-title kpi-drill-title"><span>Selected metric — ${esc(title)}</span><div class="kpi-drill-actions"><button type="button" id="kpi-drill-csv" class="btn secondary">Download this list</button><button type="button" id="kpi-drill-close" class="btn secondary">Close list</button></div></div>`;

  if (kpiId === "visibleOfficers") {
    const officers = rows.filter(r => state.data.metadata.includeUnmappedInVisibleOfficerKpi || r.status !== "Unmapped");
    const body = officers.length
      ? `<div class="detail-table-wrap"><table class="detail-table kpi-drill-table kpi-drill-officers"><thead><tr><th>Status</th><th>Officer</th><th>Planned Visits Till Date</th><th>Completion %</th></tr></thead><tbody>${officers.map(o=>`<tr><td>${esc(o.status)}</td><td>${esc(o.officer)}</td><td>${numberFmt.format(Number(o.totalPlannedTillDate)||0)}</td><td>${pct(o.completionPct)}</td></tr>`).join("")}</tbody></table></div>`
      : `<div class="details-message">No officers in the current selection.</div>`;
    target.innerHTML = `${head}<div class="kpi-drill-caption">${officers.length} officer(s) in view · outlet-level columns (Outlet Code / Outlet Name / RHO Name / Zonal Name) appear for the outlet-based metrics.</div>${body}`;
    wireKpiDrillButtons(kpiId, rows);
    return;
  }

  const records = kpiOutletRecords(kpiId, rows);
  const body = records.length
    ? `<div class="detail-table-wrap"><table class="detail-table kpi-drill-table"><thead><tr>${DRILL_COLUMNS.map(c=>`<th>${c[1]}</th>`).join("")}</tr></thead><tbody>${records.map(r=>`<tr>${DRILL_COLUMNS.map(([k])=>`<td>${esc(r[k])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
    : `<div class="details-message">No records for this metric in the current selection.</div>`;
  target.innerHTML = `${head}<div class="kpi-drill-caption">${numberFmt.format(records.length)} row(s) listed.</div>${body}`;
  wireKpiDrillButtons(kpiId, rows);
}
function wireKpiDrillButtons(kpiId, rows) {
  $("kpi-drill-close")?.addEventListener("click", () => { state.activeKpi = null; render(); });
  $("kpi-drill-csv")?.addEventListener("click", () => downloadKpiDrillCsv(kpiId, rows));
}
function downloadKpiDrillCsv(kpiId, rows) {
  let header, lines;
  if (kpiId === "visibleOfficers") {
    const officers = rows.filter(r => state.data.metadata.includeUnmappedInVisibleOfficerKpi || r.status !== "Unmapped");
    header = ["Status","Officer","Planned Visits Till Date","Completion %"];
    lines = officers.map(o => [o.status, o.officer, Number(o.totalPlannedTillDate)||0, pct(o.completionPct)]);
  } else {
    header = DRILL_COLUMNS.map(c => c[1]);
    lines = kpiOutletRecords(kpiId, rows).map(r => DRILL_COLUMNS.map(([k]) => r[k]));
  }
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
  $("summary-caption").textContent = `${rows.length} displayed rows · ${numberFmt.format(total("totalPlannedFullMonth"))} planned visits full month · ${numberFmt.format(total("totalPlannedTillDate"))} planned visits till date · ${numberFmt.format(total("remainingVisits"))} remaining with no response · ${numberFmt.format(total("neverVisitedOutlets"))} never visited outlets`;
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
  $("source-footer").textContent=`Data source: ${m.scheduleFile} + ${m.responseFile} · Generated ${new Date(m.generatedAt).toLocaleString()}${unmapped}`;
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
async function init() {
  try {
    const res=await fetch("data/dashboard_data.json",{cache:"no-store"});
    if(!res.ok) throw new Error(`dashboard_data.json returned ${res.status}`);
    state.data=await res.json();
    renderHeader(); renderDefinitions(); render();
    $("status-filter").addEventListener("change",e=>{state.status=e.target.value;updateOfficerOptions();render();});
    $("officer-filter").addEventListener("change",e=>selectOfficer(e.target.value, true));
    $("officer-search").addEventListener("input",e=>{state.search=e.target.value;render();});
    $("reset-btn").addEventListener("click",()=>{state.status="All statuses";state.officerKey=ALL_OFFICERS;state.search="";state.activeDetailTab="planned";state.activeKpi=null;$("status-filter").value=state.status;$("officer-search").value="";updateOfficerOptions();render();});
    $("download-btn").addEventListener("click",downloadCsv);
  } catch(err) {
    document.querySelector("main").innerHTML=`<div class="error-box"><strong>Dashboard could not load.</strong>\n${esc(err.message)}\n\nIf this is a new GitHub repository, open the Actions tab and confirm the Deploy Visit Compliance Dashboard workflow completed successfully.</div>`;
  }
}
init();
