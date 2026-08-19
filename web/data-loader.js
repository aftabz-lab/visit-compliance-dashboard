/*
 * Visit Compliance Dashboard data loader
 *
 * This dashboard reads its working data from the user's PC raw-data folder.
 * The selected folder handle and the last successful calculated dashboard are
 * retained in this browser's IndexedDB, so deleting/replacing raw files never
 * blanks the dashboard. Repository dashboard data is never read by this
 * module.
 */

const RESPONSE_SHEET = "Response Summary";
const RESPONSE_HEADERS = ["Response ID", "Date", "Time", "Site Code", "Created By User ID"];
const SCHEDULE_SCHEMAS = [
  { sheet: "Zonal", status: "Zonal", officerHeader: "Zonal HR Name" },
  { sheet: "RHO", status: "RHO", officerHeader: "Regional Head HR Name" },
];
const OFFICER_ALIASES = [
  { source: "Saiful Islam Maruf", target: "Siful Islam Maruf", status: "Zonal" },
  { source: "Ersadul Haque", target: "Md. Ershadul Haque", status: "Zonal" },
  { source: "Md.Tanzin hosain", target: "Tanzin Hossain", status: "Zonal" },
];

const PC_DB = "visit-compliance-pc-raw-data";
const PC_DB_VERSION = 1;

const DEFAULT_DEFINITIONS = Object.freeze({
  fullMonth: "Total Planned Visits (Full Month) counts every scheduled assignment in the selected PC visit-plan workbook.",
  tillDate: "Total Planned Visits (Till Date) counts scheduled assignments on or before the response snapshot date.",
  accepted: "Accepted Responses counts unique Response Summary rows with Response ID, Date, Site Code and Created By User ID.",
  plannedDate: "Planned-Date Responses match the same officer, outlet code and planned date.",
  other: "Other / Unplanned Responses do not match the same officer, outlet code and planned date.",
  completed: "Distinct Planned Visits Completed counts each due assignment once.",
  remaining: "Remaining Visits are planned visits through the snapshot without a planned-date response.",
  neverVisited: "Never Visited Outlets have no response from the assigned officer through the snapshot.",
  completion: "Completion % is planned visits completed plus other/unplanned responses, divided by planned visits till date.",
});

function emptyDashboardData() {
  const now = new Date().toISOString();
  return {
    metadata: {
      title: "Visit Compliance Dashboard",
      subtitle: "Choose your PC raw-data folder to load the dashboard",
      snapshotDate: null,
      reportMonth: "the selected reporting month",
      scheduleFile: "No PC schedule workbook selected",
      responseFile: "No PC response workbook selected",
      responseSheet: RESPONSE_SHEET,
      generatedAt: now,
      snapshotTakenAt: null,
      includeUnmappedInVisibleOfficerKpi: false,
      localSource: true,
      diagnostics: {
        fullMonthAssignments: 0,
        tillDateAssignments: 0,
        acceptedResponses: 0,
        duplicateResponseIdsIgnored: 0,
        rejectedResponseRows: 0,
        resolutionCounts: {},
        unmappedResponseNames: [],
      },
    },
    officers: [],
    details: {},
    outlets: {},
    definitions: { ...DEFAULT_DEFINITIONS },
  };
}

function validDashboardData(data) {
  return Boolean(
    data
      && typeof data === "object"
      && !Array.isArray(data)
      && data.metadata
      && typeof data.metadata === "object"
      && Array.isArray(data.officers)
      && data.details
      && typeof data.details === "object"
  );
}

function openPcDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PC_DB, PC_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("handles")) db.createObjectStore("handles");
      if (!db.objectStoreNames.contains("snapshots")) db.createObjectStore("snapshots");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function pcDbGet(store, key) {
  try {
    const db = await openPcDb();
    return await new Promise((resolve) => {
      const request = db.transaction(store).objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function pcDbPut(store, key, value) {
  try {
    const db = await openPcDb();
    await new Promise((resolve) => {
      const request = db.transaction(store, "readwrite").objectStore(store).put(value, key);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
    });
  } catch {
    // A blocked browser store must never stop a live local-file refresh.
  }
}

const cleanText = (value) => String(value == null ? "" : value).normalize("NFKC").replace(/\s+/g, " ").trim();
const nameKey = (value) => cleanText(value).toLocaleLowerCase();
const looseNameKey = (value) => nameKey(value).replace(/[.,'’\`"()\-_/\\]+/g, " ").replace(/\s+/g, " ").trim();
const siteKey = (value) => cleanText(value).toUpperCase();
const pad2 = (value) => String(value).padStart(2, "0");

function isoDate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return String(y) + "-" + pad2(m) + "-" + pad2(d);
}

function parseDateOnly(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return isoDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }
  if (typeof value === "number" && Number.isFinite(value) && globalThis.XLSX?.SSF?.parse_date_code) {
    const parsed = globalThis.XLSX.SSF.parse_date_code(value);
    if (parsed) return isoDate(parsed.y, parsed.m, parsed.d);
  }
  const text = cleanText(value);
  if (!text) return null;
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return isoDate(iso[1], iso[2], iso[3]);
  const separated = text.match(/^(\d{1,2})([/-])(\d{1,2})\2(\d{2,4})$/);
  if (separated) {
    const a = Number(separated[1]);
    const b = Number(separated[3]);
    let year = Number(separated[4]);
    if (year < 100) year += 2000;
    if (separated[2] === "/") {
      if (a > 12 && b <= 12) return isoDate(year, b, a);
      return isoDate(year, a, b);
    }
    return isoDate(year, b, a);
  }
  const named = text.match(/^(\d{1,2})[- ]([A-Za-z]{3,9})[- ,](\d{2,4})$/);
  if (named) {
    const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    let year = Number(named[3]);
    if (year < 100) year += 2000;
    return isoDate(year, months[named[2].slice(0, 3).toLocaleLowerCase()], named[1]);
  }
  return null;
}

function requiredXlsx() {
  if (!globalThis.XLSX) throw new Error("Excel reader did not load. Check your internet connection, refresh the page, and try again.");
  return globalThis.XLSX;
}

async function openWorkbook(file, options = {}) {
  const XLSX = requiredXlsx();
  return XLSX.read(await file.arrayBuffer(), {
    type: "array",
    // Keep Excel date cells as their original serial numbers.  SheetJS Date
    // objects can apply a browser timezone conversion, which would move the
    // planned-visit column by a day for some workbooks.
    cellDates: false,
    cellStyles: false,
    cellHTML: false,
    // Formatting, formatted display text and formulas are not used by this
    // dashboard.  Skipping them makes PC-folder refreshes much faster.
    cellText: false,
    cellFormula: false,
    cellNF: false,
    ...options,
  });
}

function exactSheetName(book, name) {
  const wanted = nameKey(name);
  return book.SheetNames.find((sheet) => nameKey(sheet) === wanted) || null;
}

function rowMap(header) {
  const map = new Map();
  header.forEach((value, index) => {
    const label = cleanText(value);
    if (label) map.set(label, index);
  });
  return map;
}

function asGrid(book, sheetName) {
  return requiredXlsx().utils.sheet_to_json(book.Sheets[sheetName], {
    header: 1,
    defval: "",
    blankrows: false,
    raw: true,
  });
}

async function isResponseWorkbook(file) {
  try {
    const book = await openWorkbook(file, {
      // Do not parse answer/detail tabs.  Response Summary is the only sheet
      // allowed to supply Visit Compliance response data.
      sheets: RESPONSE_SHEET,
      sheetRows: 3,
      dense: true,
    });
    const sheetName = exactSheetName(book, RESPONSE_SHEET);
    if (!sheetName) return false;
    const rows = asGrid(book, sheetName);
    const map = rowMap(rows[0] || []);
    return RESPONSE_HEADERS.every((header) => map.has(header));
  } catch {
    return false;
  }
}

async function readResponseWorkbook(file) {
  const book = await openWorkbook(file, {
    // The source response workbook can contain tens of thousands of answer
    // rows on other tabs.  Parsing those tabs was the reason a refresh could
    // remain on "Reading" for many minutes.  SheetJS therefore receives an
    // explicit one-sheet request here.
    sheets: RESPONSE_SHEET,
    dense: true,
  });
  const sheetName = exactSheetName(book, RESPONSE_SHEET);
  if (!sheetName) throw new Error('The selected workbook does not contain the "Response Summary" sheet.');
  const rows = asGrid(book, sheetName);
  if (!rows.length) throw new Error('"Response Summary" is empty.');
  const map = rowMap(rows[0] || []);
  for (const header of RESPONSE_HEADERS) {
    if (!map.has(header)) throw new Error('"Response Summary" is missing the "' + header + '" column.');
  }

  const accepted = [];
  const seenIds = new Set();
  let duplicateIds = 0;
  let rejectedRows = 0;
  for (const row of rows.slice(1)) {
    const get = (header) => row[map.get(header)];
    const responseId = cleanText(get("Response ID"));
    const responseDate = parseDateOnly(get("Date"));
    const siteCode = siteKey(get("Site Code"));
    const officer = cleanText(get("Created By User ID"));
    if (!responseId && !responseDate && !siteCode && !officer) continue;
    if (!responseId || !responseDate || !siteCode || !officer) {
      rejectedRows += 1;
      continue;
    }
    if (seenIds.has(responseId)) {
      duplicateIds += 1;
      continue;
    }
    seenIds.add(responseId);
    accepted.push({
      responseId,
      responseDate,
      siteCode,
      officer,
      officerNameKey: nameKey(officer),
      officerLooseKey: looseNameKey(officer),
    });
  }
  if (!accepted.length) throw new Error('"Response Summary" has no accepted response rows.');
  return {
    responses: accepted,
    diagnostics: { duplicateResponseIdsIgnored: duplicateIds, rejectedResponseRows: rejectedRows },
  };
}

async function isScheduleWorkbook(file) {
  try {
    const book = await openWorkbook(file, {
      sheets: SCHEDULE_SCHEMAS.map((schema) => schema.sheet),
      sheetRows: 4,
      dense: true,
    });
    return SCHEDULE_SCHEMAS.some((schema) => {
      const sheetName = exactSheetName(book, schema.sheet);
      if (!sheetName) return false;
      const header = asGrid(book, sheetName)[0] || [];
      const map = rowMap(header);
      return ["SL", "CODE", "Outlet Name", schema.officerHeader].every((label) => map.has(label));
    });
  } catch {
    return false;
  }
}

async function readScheduleWorkbook(file) {
  const book = await openWorkbook(file, {
    // Ignore any unrelated support sheets in the visit-plan workbook.
    sheets: SCHEDULE_SCHEMAS.map((schema) => schema.sheet),
    dense: true,
  });
  const assignments = [];
  const outlets = {};
  const seen = new Set();

  for (const schema of SCHEDULE_SCHEMAS) {
    const sheetName = exactSheetName(book, schema.sheet);
    if (!sheetName) continue;
    const rows = asGrid(book, sheetName);
    if (!rows.length) throw new Error("Schedule sheet " + schema.sheet + " is empty.");
    const header = rows[0] || [];
    const map = rowMap(header);
    for (const label of ["SL", "CODE", "Outlet Name", schema.officerHeader]) {
      if (!map.has(label)) throw new Error("Schedule sheet " + schema.sheet + ' is missing "' + label + '".');
    }
    const dateColumns = [];
    header.forEach((value, index) => {
      const label = cleanText(value);
      if (!label || ["SL", "CODE", "Outlet Name", schema.officerHeader].includes(label)) return;
      const parsed = parseDateOnly(value);
      if (parsed) dateColumns.push([index, parsed]);
    });
    if (!dateColumns.length) throw new Error("No visit-date columns were found in " + schema.sheet + ".");

    rows.slice(1).forEach((row, rowIndex) => {
      const get = (label) => row[map.get(label)];
      const siteCode = siteKey(get("CODE"));
      const outletName = cleanText(get("Outlet Name"));
      const officer = cleanText(get(schema.officerHeader));
      if (!siteCode && !officer) return;
      if (siteCode) {
        const outlet = outlets[siteCode] || { siteCode, outletName: "", rhoName: "", zonalName: "" };
        if (outletName && !outlet.outletName) outlet.outletName = outletName;
        if (schema.status === "RHO" && officer) outlet.rhoName = officer;
        if (schema.status === "Zonal" && officer) outlet.zonalName = officer;
        outlets[siteCode] = outlet;
      }
      dateColumns.forEach(([column, plannedDate]) => {
        if (nameKey(row[column]) !== "yes") return;
        if (!siteCode || !officer) throw new Error("A planned row is missing CODE or officer in " + schema.sheet + " row " + (rowIndex + 2) + ".");
        const officerKey = schema.status.toLocaleLowerCase() + "::" + nameKey(officer);
        const key = officerKey + "|" + siteCode + "|" + plannedDate;
        if (seen.has(key)) throw new Error("Duplicate planned assignment in " + schema.sheet + ".");
        seen.add(key);
        assignments.push({
          status: schema.status,
          officer,
          officerKey,
          officerNameKey: nameKey(officer),
          officerLooseKey: looseNameKey(officer),
          siteCode,
          outletName,
          plannedDate,
        });
      });
    });
  }
  if (!assignments.length) throw new Error("No planned visits were found in the local schedule workbook.");
  return { assignments, outlets, fileName: file.name };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function retainedSchedule(data) {
  if (!validDashboardData(data)) throw new Error("Select the local schedule workbook once together with the response workbook.");
  const officerByKey = new Map(data.officers.map((row) => [cleanText(row.officerKey), row]));
  const outlets = clone(data.outlets || {});
  const assignments = [];
  const seen = new Set();
  Object.entries(data.details || {}).forEach(([officerKey, detail]) => {
    const officerRecord = officerByKey.get(cleanText(officerKey));
    if (!officerRecord || !detail || !Array.isArray(detail.planned)) return;
    const status = cleanText(officerRecord.status);
    const officer = cleanText(officerRecord.officer);
    if (!status || !officer) return;
    detail.planned.forEach((planned) => {
      const siteCode = siteKey(planned.siteCode);
      const plannedDate = parseDateOnly(planned.plannedDate);
      const outletName = cleanText(planned.outletName);
      if (!siteCode || !plannedDate) return;
      const localOfficerKey = status.toLocaleLowerCase() + "::" + nameKey(officer);
      const key = localOfficerKey + "|" + siteCode + "|" + plannedDate;
      if (seen.has(key)) return;
      seen.add(key);
      assignments.push({
        status,
        officer,
        officerKey: localOfficerKey,
        officerNameKey: nameKey(officer),
        officerLooseKey: looseNameKey(officer),
        siteCode,
        outletName,
        plannedDate,
      });
      const outlet = outlets[siteCode] || { siteCode, outletName: "", rhoName: "", zonalName: "" };
      if (outletName && !outlet.outletName) outlet.outletName = outletName;
      if (status === "RHO" && officer && !outlet.rhoName) outlet.rhoName = officer;
      if (status === "Zonal" && officer && !outlet.zonalName) outlet.zonalName = officer;
      outlets[siteCode] = outlet;
    });
  });
  if (!assignments.length) throw new Error("The retained local snapshot has no reusable planned visits.");
  return { assignments, outlets, fileName: cleanText(data.metadata?.scheduleFile) || "Retained local schedule" };
}

function only(set) {
  return set && set.size === 1 ? set.values().next().value : null;
}

function resolveResponses(responses, assignments) {
  const officers = new Map();
  const byName = new Map();
  const byLoose = new Map();
  const byNameSite = new Map();
  const byLooseSite = new Map();
  const put = (map, key, value) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(value);
  };

  assignments.forEach((assignment) => {
    const key = assignment.officerKey;
    officers.set(key, { officerKey: key, status: assignment.status, officer: assignment.officer });
    put(byName, assignment.officerNameKey, key);
    put(byLoose, assignment.officerLooseKey, key);
    put(byNameSite, assignment.officerNameKey + "|" + assignment.siteCode, key);
    put(byLooseSite, assignment.officerLooseKey + "|" + assignment.siteCode, key);
  });

  const aliases = new Map();
  OFFICER_ALIASES.forEach((alias) => {
    const matches = [...officers.values()].filter((row) => row.status === alias.status && looseNameKey(row.officer) === looseNameKey(alias.target));
    if (matches.length === 1) aliases.set(looseNameKey(alias.source), matches[0].officerKey);
  });

  const counts = {};
  const resolved = responses.map((response) => {
    let officerKey = only(byName.get(response.officerNameKey));
    let method = officerKey ? "exact_name" : "";
    if (!officerKey) {
      officerKey = only(byLoose.get(response.officerLooseKey));
      method = officerKey ? "loose_name" : "";
    }
    if (!officerKey) {
      officerKey = only(byNameSite.get(response.officerNameKey + "|" + response.siteCode));
      method = officerKey ? "name_site" : "";
    }
    if (!officerKey) {
      officerKey = only(byLooseSite.get(response.officerLooseKey + "|" + response.siteCode));
      method = officerKey ? "loose_name_site" : "";
    }
    if (!officerKey && aliases.has(response.officerLooseKey)) {
      officerKey = aliases.get(response.officerLooseKey);
      method = "alias";
    }
    if (!officerKey) {
      officerKey = "unmapped::" + response.officerNameKey;
      method = "unmapped";
      if (!officers.has(officerKey)) officers.set(officerKey, { officerKey, status: "Unmapped", officer: response.officer });
    }
    counts[method] = (counts[method] || 0) + 1;
    return { ...response, officerKey, resolutionMethod: method };
  });
  return { responses: resolved, officers, resolutionCounts: counts };
}

function dateLabel(iso) {
  const parts = String(iso).split("-");
  const date = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, 1));
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

function calculateLocalDashboard(baseData, schedule, parsedResponse, responseFile, sourceMode) {
  const snapshotDate = parsedResponse.responses.reduce((latest, response) => response.responseDate > latest ? response.responseDate : latest, "0000-00-00");
  const resolved = resolveResponses(parsedResponse.responses, schedule.assignments);
  const responses = resolved.responses.filter((response) => response.responseDate <= snapshotDate);
  const planKey = (assignment) => assignment.officerKey + "|" + assignment.siteCode + "|" + assignment.plannedDate;
  const responsePlanKey = (response) => response.officerKey + "|" + response.siteCode + "|" + response.responseDate;
  const fullPlanKeys = new Set(schedule.assignments.map(planKey));
  const due = schedule.assignments.filter((assignment) => assignment.plannedDate <= snapshotDate);
  const responseCounts = new Map();
  responses.forEach((response) => {
    const key = responsePlanKey(response);
    responseCounts.set(key, (responseCounts.get(key) || 0) + 1);
  });
  const completedKeys = new Set(due.filter((assignment) => responseCounts.get(planKey(assignment))).map(planKey));
  const visitedPairs = new Set(responses.map((response) => response.officerKey + "|" + response.siteCode));

  const metrics = new Map();
  resolved.officers.forEach((officer, officerKey) => {
    metrics.set(officerKey, {
      ...officer,
      totalPlannedFullMonth: 0,
      totalPlannedTillDate: 0,
      acceptedResponses: 0,
      plannedDateResponses: 0,
      otherUnplannedResponses: 0,
      distinctPlannedVisitsCompleted: 0,
      remainingVisits: 0,
      neverVisitedOutlets: 0,
      completionPct: null,
    });
  });
  schedule.assignments.forEach((assignment) => { metrics.get(assignment.officerKey).totalPlannedFullMonth += 1; });
  due.forEach((assignment) => { metrics.get(assignment.officerKey).totalPlannedTillDate += 1; });
  responses.forEach((response) => {
    const row = metrics.get(response.officerKey);
    row.acceptedResponses += 1;
    if (fullPlanKeys.has(responsePlanKey(response))) row.plannedDateResponses += 1;
  });
  metrics.forEach((row) => { row.otherUnplannedResponses = row.acceptedResponses - row.plannedDateResponses; });
  due.forEach((assignment) => {
    if (completedKeys.has(planKey(assignment))) metrics.get(assignment.officerKey).distinctPlannedVisitsCompleted += 1;
  });

  const neverByOfficer = new Map();
  due.forEach((assignment) => {
    const pair = assignment.officerKey + "|" + assignment.siteCode;
    if (visitedPairs.has(pair)) return;
    if (!neverByOfficer.has(assignment.officerKey)) neverByOfficer.set(assignment.officerKey, new Set());
    neverByOfficer.get(assignment.officerKey).add(assignment.siteCode);
  });
  metrics.forEach((row, officerKey) => {
    row.remainingVisits = row.totalPlannedTillDate - row.distinctPlannedVisitsCompleted;
    row.neverVisitedOutlets = neverByOfficer.get(officerKey)?.size || 0;
    if (row.totalPlannedTillDate) row.completionPct = ((row.distinctPlannedVisitsCompleted + row.otherUnplannedResponses) / row.totalPlannedTillDate) * 100;
  });

  const outletNameBySite = new Map();
  schedule.assignments.forEach((assignment) => {
    if (assignment.siteCode && assignment.outletName && !outletNameBySite.has(assignment.siteCode)) outletNameBySite.set(assignment.siteCode, assignment.outletName);
  });
  const details = {};
  metrics.forEach((metric, officerKey) => {
    const full = schedule.assignments.filter((assignment) => assignment.officerKey === officerKey);
    const dueOfficer = due.filter((assignment) => assignment.officerKey === officerKey);
    const officerResponses = responses.filter((response) => response.officerKey === officerKey);
    const planned = full.map((assignment) => ({ plannedDate: assignment.plannedDate, siteCode: assignment.siteCode, outletName: assignment.outletName }));
    const remaining = dueOfficer.filter((assignment) => !completedKeys.has(planKey(assignment))).map((assignment) => ({ plannedDate: assignment.plannedDate, siteCode: assignment.siteCode, outletName: assignment.outletName }));
    const completed = dueOfficer.filter((assignment) => completedKeys.has(planKey(assignment))).map((assignment) => ({ plannedDate: assignment.plannedDate, siteCode: assignment.siteCode, outletName: assignment.outletName }));
    const neverMap = new Map();
    dueOfficer.forEach((assignment) => {
      if (!visitedPairs.has(officerKey + "|" + assignment.siteCode)) neverMap.set(assignment.siteCode, { siteCode: assignment.siteCode, outletName: assignment.outletName });
    });
    const plannedDateResponseList = [];
    const otherUnplannedResponseList = [];
    officerResponses.forEach((response) => {
      const item = { responseDate: response.responseDate, siteCode: response.siteCode, outletName: outletNameBySite.get(response.siteCode) || "", responseId: response.responseId };
      if (fullPlanKeys.has(responsePlanKey(response))) plannedDateResponseList.push(item);
      else otherUnplannedResponseList.push(item);
    });
    const sortPlan = (a, b) => (a.plannedDate || "").localeCompare(b.plannedDate || "") || (a.siteCode || "").localeCompare(b.siteCode || "");
    const sortResponse = (a, b) => (a.responseDate || "").localeCompare(b.responseDate || "") || (a.siteCode || "").localeCompare(b.siteCode || "") || String(a.responseId || "").localeCompare(String(b.responseId || ""));
    details[officerKey] = {
      planned: planned.sort(sortPlan),
      completed: completed.sort(sortPlan),
      remaining: remaining.sort(sortPlan),
      neverVisited: [...neverMap.values()].sort((a, b) => a.siteCode.localeCompare(b.siteCode)),
      plannedDateResponseList: plannedDateResponseList.sort(sortResponse),
      otherUnplannedResponseList: otherUnplannedResponseList.sort(sortResponse),
    };
  });

  const outlets = clone(schedule.outlets || {});
  Object.values(outlets).forEach((outlet) => {
    outlet.lastVisit = null;
    outlet.lastVisitBy = "";
    outlet.lastVisitZonal = null;
    outlet.lastVisitZonalBy = "";
    outlet.lastVisitRho = null;
    outlet.lastVisitRhoBy = "";
  });
  responses.forEach((response) => {
    const outlet = outlets[response.siteCode] || {
      siteCode: response.siteCode, outletName: "", rhoName: "", zonalName: "", unscheduled: true,
      lastVisit: null, lastVisitBy: "", lastVisitZonal: null, lastVisitZonalBy: "", lastVisitRho: null, lastVisitRhoBy: "",
    };
    const status = resolved.officers.get(response.officerKey)?.status || "";
    if (!outlet.lastVisit || response.responseDate > outlet.lastVisit) {
      outlet.lastVisit = response.responseDate;
      outlet.lastVisitBy = response.officer;
    }
    if (status === "Zonal" && (!outlet.lastVisitZonal || response.responseDate > outlet.lastVisitZonal)) {
      outlet.lastVisitZonal = response.responseDate;
      outlet.lastVisitZonalBy = response.officer;
    }
    if (status === "RHO" && (!outlet.lastVisitRho || response.responseDate > outlet.lastVisitRho)) {
      outlet.lastVisitRho = response.responseDate;
      outlet.lastVisitRhoBy = response.officer;
    }
    outlets[response.siteCode] = outlet;
  });

  const statusOrder = { RHO: 0, Unmapped: 1, Zonal: 2 };
  const officers = [...metrics.values()].sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9) || a.officer.localeCompare(b.officer, undefined, { sensitivity: "base" }));
  const baseMeta = baseData?.metadata || {};
  const now = new Date().toISOString();
  const uniqueUnmapped = [...new Set(responses.filter((row) => row.resolutionMethod === "unmapped").map((row) => row.officer))].sort();
  const reportMonth = dateLabel(snapshotDate);
  return {
    metadata: {
      ...baseMeta,
      title: reportMonth + " Visit Compliance Dashboard",
      subtitle: baseMeta.subtitle || "Officer-wise planned visit and audit-response performance",
      snapshotDate,
      reportMonth,
      scheduleFile: schedule.fileName,
      scheduleSource: sourceMode === "pc-folder" && schedule.isRaw ? "PC raw-data folder" : "retained local schedule snapshot",
      responseFile: responseFile.name,
      responseSheet: RESPONSE_SHEET,
      supersededFiles: [],
      generatedAt: now,
      snapshotTakenAt: now,
      includeUnmappedInVisibleOfficerKpi: Boolean(baseMeta.includeUnmappedInVisibleOfficerKpi),
      localSource: true,
      diagnostics: {
        fullMonthAssignments: schedule.assignments.length,
        tillDateAssignments: due.length,
        acceptedResponses: responses.length,
        duplicateResponseIdsIgnored: parsedResponse.diagnostics.duplicateResponseIdsIgnored,
        rejectedResponseRows: parsedResponse.diagnostics.rejectedResponseRows,
        resolutionCounts: resolved.resolutionCounts,
        unmappedResponseNames: uniqueUnmapped,
      },
    },
    officers,
    details,
    outlets,
    definitions: { ...DEFAULT_DEFINITIONS, ...(baseData?.definitions || {}) },
  };
}

function fileSignature(file) {
  return file.name + "|" + file.lastModified + "|" + file.size;
}

function folderSignature(files) {
  return files
    .map((file) => fileSignature(file))
    .sort()
    .join("||");
}

async function folderWorkbookFiles(handle) {
  const files = [];
  for await (const [name, entry] of handle.entries()) {
    if (entry.kind !== "file" || name.startsWith("~$") || !/\.(xlsx|xlsm|xls)$/i.test(name)) continue;
    files.push(await entry.getFile());
  }
  files.sort((a, b) => b.lastModified - a.lastModified || a.name.localeCompare(b.name));
  return files;
}

function responseFilePriority(file) {
  const name = nameKey(file?.name);
  const isSchedule = /visit\s*schedule|visit\s*plan|compiled\s*visit|\bschedule\b/.test(name);
  if (isSchedule) return 9;
  if (/store\s*operations.*compliance.*audit.*response/.test(name)) return 0;
  if (/\bresponse\b.*\baudit\b|\baudit\b.*\bresponse\b/.test(name)) return 1;
  if (/\bresponse\b/.test(name)) return 2;
  if (/\baudit\b/.test(name)) return 3;
  return 5;
}

function scheduleFilePriority(file) {
  const name = nameKey(file?.name);
  if (/master.*compiled.*visit|compiled.*visit|visit.*schedule/.test(name)) return 0;
  if (/\bschedule\b|\bvisit\s*plan\b|\bplan\b/.test(name)) return 1;
  return 5;
}

function orderFilesByPriority(files, priority) {
  return [...files].sort((a, b) =>
    priority(a) - priority(b)
    || b.lastModified - a.lastModified
    || a.name.localeCompare(b.name)
  );
}

async function findResponseFile(files) {
  // In normal use the response file name contains "response" or "audit".
  // Check it first, then fall back to other workbooks only when needed.  The
  // actual confirmation is still the exact Response Summary sheet + headers.
  for (const file of orderFilesByPriority(files, responseFilePriority)) {
    try {
      const parsed = await readResponseWorkbook(file);
      return { file, parsed };
    } catch {
      // The exact Response Summary sheet is absent or not usable. Try the
      // next workbook without reading its unrelated sheets.
    }
  }
  return null;
}

async function findScheduleFile(files, responseFile) {
  const ordered = orderFilesByPriority(files.filter((file) => file !== responseFile), scheduleFilePriority);
  for (const file of ordered) {
    try {
      return { file, schedule: await readScheduleWorkbook(file) };
    } catch {
      // This workbook is not the required Zonal/RHO visit schedule.
    }
  }
  return null;
}

class PcRawDataSource {
  constructor() {
    this.dirHandle = null;
    this.currentData = null;
    this.currentSignature = "";
    this.currentFolderSignature = "";
    this.savedAt = null;
    this.baseData = null;
    this.onData = null;
    this.onStatus = null;
    this.watchTimer = null;
    this.boundVisibility = false;
    this.refreshPromise = null;
  }

  result(data, source, usingLastData, status) {
    return {
      data,
      source,
      usingLastData,
      lastFetched: this.savedAt || data?.metadata?.snapshotTakenAt || null,
      localStatus: status || null,
      localSource: this,
    };
  }

  async initialize() {
    this.dirHandle = await pcDbGet("handles", "folder");
    const saved = await pcDbGet("snapshots", "latest");
    if (saved?.data && validDashboardData(saved.data) && saved.data.metadata?.localSource) {
      this.currentData = saved.data;
      this.currentSignature = saved.signature || "";
      this.currentFolderSignature = saved.folderSignature || "";
      this.savedAt = saved.savedAt || saved.data.metadata?.snapshotTakenAt || null;
      return this.result(saved.data, "local-cache", true, {
        kind: "saved",
        message: "Showing the last successful snapshot saved in this browser.",
      });
    }
    return null;
  }

  attach({ baseData, onData, onStatus }) {
    this.baseData = baseData;
    this.onData = onData;
    this.onStatus = onStatus;
    this.bindControls();
    this.refreshFolder({ silent: true });
    this.startWatching();
  }

  setStatus(status) {
    if (this.onStatus) this.onStatus(status);
  }

  sendData(data, source, usingLastData, status) {
    this.currentData = data;
    this.savedAt = data.metadata?.snapshotTakenAt || new Date().toISOString();
    if (this.onData) this.onData(this.result(data, source, usingLastData, status));
  }

  async saveLatest(data, signature, folderStateSignature = "") {
    this.currentData = data;
    this.currentSignature = signature;
    this.currentFolderSignature = folderStateSignature;
    this.savedAt = data.metadata?.snapshotTakenAt || new Date().toISOString();
    await pcDbPut("snapshots", "latest", {
      data,
      signature,
      folderSignature: folderStateSignature,
      savedAt: this.savedAt,
    });
  }

  bindControls() {
    const grant = document.getElementById("grant-folder");
    const folder = document.getElementById("pick-folder");
    const input = document.getElementById("pick-file");
    const single = document.getElementById("pick-file-btn");
    grant?.addEventListener("click", () => this.grantFolder());
    folder?.addEventListener("click", () => this.pickFolder());
    single?.addEventListener("click", () => input?.click());
    input?.addEventListener("change", () => {
      const file = input.files?.[0];
      input.value = "";
      if (file) this.useSingleFile(file);
    });
  }

  async pickFolder() {
    if (!window.showDirectoryPicker) {
      this.setStatus({ kind: "error", message: "This browser cannot open folders. Use Chrome or Edge, or select the response Excel with Open a single file." });
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({ id: "visit-compliance-raw-data", mode: "read" });
      this.dirHandle = handle;
      this.currentSignature = "";
      this.currentFolderSignature = "";
      await pcDbPut("handles", "folder", handle);
      await this.refreshFolder({ silent: false });
      this.startWatching();
    } catch (error) {
      if (error?.name !== "AbortError") this.setStatus({ kind: "error", message: error.message || "Could not open the selected folder." });
    }
  }

  async grantFolder() {
    if (!this.dirHandle) return this.pickFolder();
    try {
      const permission = await this.dirHandle.requestPermission({ mode: "read" });
      if (permission === "granted") {
        this.currentSignature = "";
        this.currentFolderSignature = "";
        await this.refreshFolder({ silent: false });
        this.startWatching();
      }
    } catch (error) {
      this.setStatus({ kind: "error", message: error.message || "Folder access was not granted." });
    }
  }

  async folderPermission() {
    if (!this.dirHandle) return "denied";
    try {
      return await this.dirHandle.queryPermission({ mode: "read" });
    } catch {
      return "denied";
    }
  }

  fallback(reason, kind = "saved") {
    if (!this.currentData) return false;
    this.sendData(this.currentData, "local-cache", true, { kind, message: reason });
    return true;
  }

  async refreshFolder(options = {}) {
    // The folder watcher runs every five seconds.  Never start another Excel
    // parse while the previous refresh is still running.
    if (this.refreshPromise) return this.refreshPromise;
    const run = this.refreshFolderNow(options);
    this.refreshPromise = run;
    try {
      return await run;
    } finally {
      if (this.refreshPromise === run) this.refreshPromise = null;
    }
  }

  async refreshFolderNow({ silent = true } = {}) {
    if (!this.dirHandle) {
      if (!this.currentData) this.setStatus({ kind: "idle", message: "Select your PC raw-data folder to load the latest response workbook." });
      return;
    }
    const permission = await this.folderPermission();
    if (permission !== "granted") {
      document.getElementById("grant-folder").hidden = false;
      const message = "The browser needs one click to reopen your remembered PC folder.";
      if (!this.fallback(message, "needs-grant")) this.setStatus({ kind: "needs-grant", message });
      return;
    }
    document.getElementById("grant-folder").hidden = true;
    try {
      const files = await folderWorkbookFiles(this.dirHandle);
      const currentFolderSignature = folderSignature(files);

      // After the first snapshot, checking file names, sizes and modified
      // times is enough.  Do not reopen the large response workbook on every
      // watcher tick when the PC folder has not changed.
      if (this.currentData && currentFolderSignature === this.currentFolderSignature) {
        this.setStatus({ kind: "live", message: "Watching the selected PC folder. Only the Response Summary sheet is read." });
        return;
      }

      const responseSource = await findResponseFile(files);
      if (!responseSource) {
        const message = files.length ? 'No Excel file in this folder contains the exact "Response Summary" sheet.' : "The selected PC raw-data folder is empty.";
        if (!this.fallback(message) && !silent) this.setStatus({ kind: "empty", message });
        return;
      }
      const scheduleSource = await findScheduleFile(files, responseSource.file);
      const signature = fileSignature(responseSource.file) + "|" + (scheduleSource ? fileSignature(scheduleSource.file) : "retained-plan");
      if (signature === this.currentSignature && this.currentData) {
        this.currentFolderSignature = currentFolderSignature;
        this.setStatus({ kind: "live", message: "Watching the selected PC folder. Only the Response Summary sheet is read." });
        return;
      }
      this.setStatus({ kind: "reading", message: "Reading " + responseSource.file.name + " from your PC folder…" });
      await this.applyResponseFile(
        responseSource.file,
        "pc-folder",
        scheduleSource?.file || null,
        signature,
        responseSource.parsed,
        scheduleSource?.schedule || null,
        currentFolderSignature,
      );
    } catch (error) {
      const message = error?.message || "Could not read the PC raw-data folder.";
      if (!this.fallback(message) && !silent) this.setStatus({ kind: "error", message });
    }
  }

  async useSingleFile(file) {
    try {
      this.dirHandle = null;
      await pcDbPut("handles", "folder", null);
      this.setStatus({ kind: "reading", message: "Reading " + file.name + " from your PC…" });
      await this.applyResponseFile(file, "pc-file", null, fileSignature(file) + "|single-file");
    } catch (error) {
      const message = error?.message || "Could not read the selected response workbook.";
      if (!this.fallback(message)) this.setStatus({ kind: "error", message });
    }
  }

  async applyResponseFile(responseFile, source, scheduleFile, signature, parsedResponse = null, parsedSchedule = null, folderStateSignature = "") {
    const responseData = parsedResponse || await readResponseWorkbook(responseFile);
    let schedule;
    if (scheduleFile) {
      this.setStatus({ kind: "reading", message: "Reading the visit plan and " + responseFile.name + " from your PC folder…" });
      schedule = parsedSchedule || await readScheduleWorkbook(scheduleFile);
      schedule.isRaw = true;
    } else {
      if (!this.currentData?.metadata?.localSource) {
        throw new Error("For the first PC-folder setup, keep the Visit Schedule workbook in the same folder as the response workbook. After one successful local snapshot, the response workbook alone is enough.");
      }
      schedule = retainedSchedule(this.currentData);
      schedule.isRaw = false;
    }
    const baseline = this.currentData || this.baseData;
    const data = calculateLocalDashboard(baseline, schedule, responseData, responseFile, source);
    await this.saveLatest(data, signature, folderStateSignature);
    this.sendData(data, source, false, {
      kind: "live",
      message: source === "pc-folder"
        ? "Live from your selected PC raw-data folder. Only the Response Summary sheet is read."
        : "Live from the response workbook selected on your PC. The snapshot is saved in this browser.",
    });
  }

  startWatching() {
    if (!this.dirHandle || this.watchTimer) return;
    this.watchTimer = window.setInterval(() => {
      if (!document.hidden) this.refreshFolder({ silent: true });
    }, 5000);
    if (!this.boundVisibility) {
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) this.refreshFolder({ silent: true });
      });
      this.boundVisibility = true;
    }
  }
}

export async function loadDashboardData() {
  const localSource = new PcRawDataSource();
  const local = await localSource.initialize();
  if (local) return local;
  return {
    data: emptyDashboardData(),
    source: "awaiting-local",
    usingLastData: false,
    lastFetched: null,
    localStatus: {
      kind: "idle",
      message: "No repository data is used. Choose your PC raw-data folder to load the visit schedule and response workbook.",
    },
    localSource,
  };
}

export function attachPcRawDataSource(localSource, options) {
  if (localSource) localSource.attach(options);
}

export function getDataStatus(result) {
  if (result?.source === "pc-folder") return { type: "pc-folder", text: "Showing a live snapshot from the selected PC raw-data folder." };
  if (result?.source === "pc-file") return { type: "pc-file", text: "Showing a live snapshot from the response workbook selected on this PC." };
  if (result?.source === "local-cache") return { type: "local-cache", text: "The local source is unavailable. Showing the last successful snapshot saved in this browser." };
  return { type: "awaiting-local", text: "No local snapshot yet. Choose your PC raw-data folder to load the dashboard." };
}
