const VISIT_SHEET_NAME = "Visit Compliance";
const AUDIT_SHEET_NAME = "Audit";
const HEADER_ROW = 9;

const COLORS = {
  navy: "FF0B2239",
  navySoft: "FF173B5E",
  blue: "FF1598C9",
  bluePale: "FFE9F6FB",
  green: "FF2AA876",
  greenPale: "FFEAF7F1",
  amber: "FFF0A202",
  amberPale: "FFFFF5DC",
  red: "FFE25565",
  redPale: "FFFFEDEF",
  ink: "FF102A43",
  muted: "FF5D7285",
  white: "FFFFFFFF",
  line: "FFD9E4EC",
};

function text(value) {
  return String(value ?? "").trim();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function siteCode(value) {
  return text(value).toUpperCase();
}

function parseDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return new Date(value.getTime());
  if (typeof value === "number" && Number.isFinite(value)) {
    const excelEpoch = Date.UTC(1899, 11, 30);
    return new Date(excelEpoch + (value * 86400000));
  }
  const raw = text(value);
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  const locale = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?)?$/i);
  if (locale) {
    let hour = Number(locale[4] || 0);
    const minute = Number(locale[5] || 0);
    const second = Number(locale[6] || 0);
    const meridiem = locale[7]?.toUpperCase();
    if (meridiem === "PM" && hour < 12) hour += 12;
    if (meridiem === "AM" && hour === 12) hour = 0;
    return new Date(Date.UTC(Number(locale[3]), Number(locale[1]) - 1, Number(locale[2]), hour, minute, second));
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dateRank(value) {
  const parsed = parseDate(value);
  return parsed ? parsed.getTime() : -Infinity;
}

function responseRank(value) {
  const raw = text(value);
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : raw;
}

function compareResponseRank(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

function monthStart(value) {
  const parsed = parseDate(value);
  return parsed ? new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), 1)) : null;
}

function isoDate(value) {
  const parsed = parseDate(value);
  if (!parsed) return "";
  const year = parsed.getUTCFullYear();
  const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const day = String(parsed.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function displayDate(value) {
  const parsed = parseDate(value);
  if (!parsed) return "Not available";
  return parsed.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit", timeZone: "UTC" });
}

function parseTimeFraction(value) {
  const raw = text(value);
  if (!raw || raw === "—") return null;
  const match = raw.match(/^(\d{1,2}):(\d{2})(?:\s*([AP]M))?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toUpperCase();
  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return ((hour * 60) + minute) / 1440;
}

function durationMinutes(inTime, outTime) {
  const start = parseTimeFraction(inTime);
  const end = parseTimeFraction(outTime);
  if (start == null || end == null || end < start) return null;
  return Math.round((end - start) * 1440);
}

function scoreBand(score) {
  if (!Number.isFinite(score)) return "Not scored";
  if (score >= 100) return "100% & above";
  const floor = Math.max(0, Math.min(99, Math.floor(score / 10) * 10));
  return `${floor}% to ${floor + 9}%`;
}

function scoreTone(score) {
  if (!Number.isFinite(score)) return { font: COLORS.muted, fill: COLORS.bluePale };
  if (score >= 85) return { font: COLORS.green, fill: COLORS.greenPale };
  if (score >= 75) return { font: "FF6F9E36", fill: "FFF0F8E7" };
  if (score >= 65) return { font: "FFB57600", fill: COLORS.amberPale };
  return { font: COLORS.red, fill: COLORS.redPale };
}

function outletMeta(data, code) {
  const outlet = data?.outlets?.[code] || {};
  return {
    name: text(outlet.outletName),
    zonal: text(outlet.zonalName),
    rho: text(outlet.rhoName),
  };
}

function buildAuditModel(packedRows, data) {
  const rows = (packedRows || []).filter(Array.isArray);
  const latest = new Map();
  const groups = new Map();
  const categories = new Set();

  rows.forEach(row => {
    const responseId = text(row[0]);
    const code = siteCode(row[1]);
    if (!responseId || !code) return;
    const category = text(row[2]) || "Uncategorised";
    const question = text(row[3]);
    const maxScore = number(row[4]);
    const answerScore = number(row[5]);
    const rawDate = row[6];
    const rank = dateRank(rawDate);
    const rid = responseRank(responseId);

    const current = latest.get(code);
    if (!current || rank > current.dateRank || (rank === current.dateRank && compareResponseRank(rid, current.responseRank) > 0)) {
      latest.set(code, { responseId, dateRank: rank, responseRank: rid });
    }

    categories.add(category);
    const key = `${code}\u0000${responseId}`;
    const record = groups.get(key) || {
      code,
      responseId,
      date: parseDate(rawDate),
      dateRank: rank,
      earned: 0,
      available: 0,
      scoredQuestions: 0,
      categories: new Map(),
      questionRows: 0,
    };
    record.questionRows += 1;
    if (rank > record.dateRank) {
      record.date = parseDate(rawDate);
      record.dateRank = rank;
    }
    if (maxScore != null && maxScore > 0 && answerScore != null) {
      record.earned += answerScore;
      record.available += maxScore;
      record.scoredQuestions += 1;
      const categoryTotal = record.categories.get(category) || { earned: 0, available: 0 };
      categoryTotal.earned += answerScore;
      categoryTotal.available += maxScore;
      record.categories.set(category, categoryTotal);
    }
    if (question && !record.firstQuestion) record.firstQuestion = question;
    groups.set(key, record);
  });

  const categoryNames = [...categories].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const records = [...groups.values()].map(record => {
    const selected = latest.get(record.code);
    const score = record.available > 0 ? (100 * record.earned / record.available) : null;
    let weakestCategory = "";
    let weakestCategoryScore = null;
    record.categories.forEach((totals, category) => {
      const categoryScore = totals.available > 0 ? (100 * totals.earned / totals.available) : null;
      if (categoryScore == null) return;
      if (weakestCategoryScore == null || categoryScore < weakestCategoryScore || (categoryScore === weakestCategoryScore && category < weakestCategory)) {
        weakestCategory = category;
        weakestCategoryScore = categoryScore;
      }
    });
    return {
      ...record,
      score,
      latest: selected?.responseId === record.responseId,
      weakestCategory,
      weakestCategoryScore,
      owner: outletMeta(data, record.code),
    };
  }).sort((a, b) =>
    a.code.localeCompare(b.code, undefined, { numeric: true, sensitivity: "base" })
    || Number(b.latest) - Number(a.latest)
    || b.dateRank - a.dateRank
    || compareResponseRank(responseRank(b.responseId), responseRank(a.responseId))
  );

  const latestBySite = new Map();
  records.forEach(record => {
    if (!record.latest || latestBySite.has(record.code)) return;
    latestBySite.set(record.code, record);
  });

  return { records, categoryNames, latestBySite };
}

function buildVisitRecords(data) {
  const snapshotDate = text(data?.metadata?.snapshotDate);
  const records = [];
  (data?.officers || []).forEach(officer => {
    const detail = data?.details?.[officer.officerKey] || {};
    const responseMap = new Map();
    (detail.plannedDateResponseList || []).forEach(response => {
      responseMap.set(`${siteCode(response.siteCode)}|${text(response.responseDate)}`, response);
    });
    const neverVisited = new Set((detail.neverVisited || []).map(item => siteCode(item.siteCode)));

    (detail.planned || []).forEach(plan => {
      const plannedDate = text(plan.plannedDate);
      if (snapshotDate && plannedDate > snapshotDate) return;
      const code = siteCode(plan.siteCode);
      const response = responseMap.get(`${code}|${plannedDate}`);
      const owner = outletMeta(data, code);
      const inTime = text(response?.inTime);
      const outTime = text(response?.outTime);
      records.push({
        officerType: text(officer.status),
        officer: text(officer.officer),
        code,
        outletName: text(plan.outletName) || owner.name,
        owner,
        plannedDate: parseDate(plannedDate),
        status: response ? "Completed" : "Pending",
        inTime: parseTimeFraction(inTime),
        outTime: parseTimeFraction(outTime),
        duration: durationMinutes(inTime, outTime),
        actualDate: parseDate(response?.responseDate),
        responseId: text(response?.responseId) || null,
        remarks: response ? "Planned-date response" : "Pending visit",
        neverVisited: !response && neverVisited.has(code),
      });
    });

    (detail.otherUnplannedResponseList || []).forEach(response => {
      const code = siteCode(response.siteCode);
      const owner = outletMeta(data, code);
      const inTime = text(response.inTime);
      const outTime = text(response.outTime);
      records.push({
        officerType: text(officer.status),
        officer: text(officer.officer),
        code,
        outletName: text(response.outletName) || owner.name,
        owner,
        plannedDate: null,
        status: "Completed (Extra)",
        inTime: parseTimeFraction(inTime),
        outTime: parseTimeFraction(outTime),
        duration: durationMinutes(inTime, outTime),
        actualDate: parseDate(response.responseDate),
        responseId: text(response.responseId) || null,
        remarks: "Other / unplanned response",
        neverVisited: false,
      });
    });
  });

  return records.sort((a, b) => {
    const aDate = (a.plannedDate || a.actualDate)?.getTime() ?? Infinity;
    const bDate = (b.plannedDate || b.actualDate)?.getTime() ?? Infinity;
    return aDate - bDate
      || a.officerType.localeCompare(b.officerType)
      || a.officer.localeCompare(b.officer, undefined, { sensitivity: "base" })
      || a.code.localeCompare(b.code, undefined, { numeric: true, sensitivity: "base" });
  });
}

function visitSummary(data) {
  const officers = data?.officers || [];
  const planned = officers.reduce((sum, row) => sum + (Number(row.totalPlannedTillDate) || 0), 0);
  const completed = officers.reduce((sum, row) => sum + (Number(row.distinctPlannedVisitsCompleted) || 0) + (Number(row.otherUnplannedResponses) || 0), 0);
  const pending = officers.reduce((sum, row) => sum + (Number(row.remainingVisits) || 0), 0);
  const accepted = officers.reduce((sum, row) => sum + (Number(row.acceptedResponses) || 0), 0);
  const never = new Set();
  officers.forEach(officer => (data?.details?.[officer.officerKey]?.neverVisited || []).forEach(row => never.add(siteCode(row.siteCode))));
  return {
    planned,
    completed,
    pending,
    accepted,
    never: never.size,
    completion: planned ? completed / planned : null,
  };
}

function auditSummary(model) {
  const latest = [...model.latestBySite.values()];
  const earned = latest.reduce((sum, row) => sum + row.earned, 0);
  const available = latest.reduce((sum, row) => sum + row.available, 0);
  return {
    audits: latest.length,
    outlets: new Set(latest.map(row => row.code)).size,
    earned,
    available,
    pointsLost: Math.max(0, available - earned),
    score: available ? earned / available : null,
  };
}

function lastColumnLetter(columnCount) {
  let value = columnCount;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function applyCellFill(cell, argb) {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
}

function styleTitle(sheet, columnCount, title, subtitle) {
  const end = lastColumnLetter(columnCount);
  sheet.mergeCells(`A1:${end}1`);
  sheet.getCell("A1").value = title;
  sheet.getCell("A1").font = { name: "Aptos Display", size: 22, bold: true, color: { argb: COLORS.white } };
  sheet.getCell("A1").alignment = { vertical: "middle", horizontal: "left" };
  sheet.getRow(1).height = 38;
  for (let column = 1; column <= columnCount; column += 1) applyCellFill(sheet.getCell(1, column), COLORS.navy);

  sheet.mergeCells(`A2:${end}2`);
  sheet.getCell("A2").value = subtitle;
  sheet.getCell("A2").font = { name: "Aptos", size: 10, color: { argb: COLORS.muted } };
  sheet.getCell("A2").alignment = { vertical: "middle", horizontal: "left" };
  sheet.getRow(2).height = 22;
}

function addSummaryCards(sheet, cards) {
  const spans = [[1, 3], [4, 6], [7, 9], [10, 12], [13, 15], [16, 18]];
  cards.slice(0, spans.length).forEach((card, index) => {
    const [start, end] = spans[index];
    for (let row = 4; row <= 5; row += 1) {
      for (let column = start; column <= end; column += 1) {
        const cell = sheet.getCell(row, column);
        applyCellFill(cell, card.fill);
        cell.border = {
          top: { style: "thin", color: { argb: COLORS.line } },
          bottom: { style: "thin", color: { argb: COLORS.line } },
          left: { style: "thin", color: { argb: COLORS.line } },
          right: { style: "thin", color: { argb: COLORS.line } },
        };
      }
    }
    sheet.mergeCells(4, start, 4, end);
    sheet.mergeCells(5, start, 5, end);
    const labelCell = sheet.getCell(4, start);
    labelCell.value = card.label;
    labelCell.font = { name: "Aptos", size: 9, bold: true, color: { argb: COLORS.muted } };
    labelCell.alignment = { vertical: "middle", horizontal: "left" };
    const valueCell = sheet.getCell(5, start);
    valueCell.value = card.value;
    valueCell.numFmt = card.numFmt || "#,##0";
    valueCell.font = { name: "Aptos Display", size: 18, bold: true, color: { argb: card.font } };
    valueCell.alignment = { vertical: "middle", horizontal: "left" };
  });
  sheet.getRow(4).height = 22;
  sheet.getRow(5).height = 31;
}

function addNavigationNote(sheet, columnCount, textValue, hyperlink) {
  const end = lastColumnLetter(columnCount);
  sheet.mergeCells(`A7:${end}7`);
  const cell = sheet.getCell("A7");
  cell.value = { text: textValue, hyperlink, tooltip: textValue };
  cell.font = { name: "Aptos", size: 10, bold: true, underline: true, color: { argb: COLORS.blue } };
  cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
  applyCellFill(cell, COLORS.bluePale);
  sheet.getRow(7).height = 28;
}

function addTable(sheet, name, headers, rows, theme) {
  sheet.addTable({
    name,
    ref: `A${HEADER_ROW}`,
    headerRow: true,
    totalsRow: false,
    style: { theme, showFirstColumn: false, showLastColumn: false, showRowStripes: true, showColumnStripes: false },
    columns: headers.map(header => ({ name: header, filterButton: true })),
    rows,
  });
  const header = sheet.getRow(HEADER_ROW);
  header.height = 35;
  header.eachCell(cell => {
    cell.font = { name: "Aptos", size: 10, bold: true, color: { argb: COLORS.white } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    applyCellFill(cell, COLORS.navySoft);
  });
  sheet.views = [{ state: "frozen", ySplit: HEADER_ROW, topLeftCell: `A${HEADER_ROW + 1}`, activeCell: `A${HEADER_ROW + 1}`, showGridLines: false }];
}

function setColumnWidths(sheet, widths) {
  widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
}

function styleVisitRows(sheet, rowCount, auditScoreColumn, auditLinkColumn) {
  const start = HEADER_ROW + 1;
  const end = HEADER_ROW + rowCount;
  for (let row = start; row <= end; row += 1) {
    const statusCell = sheet.getCell(row, 9);
    const status = text(statusCell.value);
    if (status === "Completed") applyCellFill(statusCell, COLORS.greenPale);
    else if (status.includes("Extra")) applyCellFill(statusCell, COLORS.bluePale);
    else applyCellFill(statusCell, COLORS.redPale);
    statusCell.font = { name: "Aptos", size: 10, bold: true, color: { argb: status === "Pending" ? COLORS.red : COLORS.green } };

    const neverCell = sheet.getCell(row, 16);
    if (neverCell.value === "Yes") {
      applyCellFill(neverCell, COLORS.amberPale);
      neverCell.font = { name: "Aptos", size: 10, bold: true, color: { argb: "FFB57600" } };
    }

    const scoreCell = sheet.getCell(row, auditScoreColumn);
    const scoreValue = scoreCell.value && typeof scoreCell.value === "object"
      ? scoreCell.value.result
      : scoreCell.value;
    const score = scoreValue === null || scoreValue === undefined || scoreValue === "" ? null : Number(scoreValue);
    if (score != null && Number.isFinite(score)) {
      const tone = scoreTone(score * 100);
      applyCellFill(scoreCell, tone.fill);
      scoreCell.font = { name: "Aptos", size: 10, bold: true, color: { argb: tone.font } };
      const linkCell = sheet.getCell(row, auditLinkColumn);
      applyCellFill(linkCell, tone.fill);
      linkCell.font = { name: "Aptos", size: 10, bold: true, underline: true, color: { argb: tone.font } };
    }
  }
}

function styleAuditRows(sheet, rowCount) {
  const start = HEADER_ROW + 1;
  const end = HEADER_ROW + rowCount;
  for (let row = start; row <= end; row += 1) {
    const latestCell = sheet.getCell(row, 8);
    if (latestCell.value === "Yes") {
      applyCellFill(latestCell, COLORS.greenPale);
      latestCell.font = { name: "Aptos", size: 10, bold: true, color: { argb: COLORS.green } };
    }
    const scoreCell = sheet.getCell(row, 13);
    const score = scoreCell.value === null || scoreCell.value === undefined || scoreCell.value === ""
      ? null
      : Number(scoreCell.value);
    if (score != null && Number.isFinite(score)) {
      const tone = scoreTone(score * 100);
      applyCellFill(scoreCell, tone.fill);
      scoreCell.font = { name: "Aptos", size: 10, bold: true, color: { argb: tone.font } };
    }
  }
}

function setupSheet(sheet, lastColumn) {
  sheet.properties.defaultRowHeight = 18;
  sheet.pageSetup = {
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    printTitlesRow: "1:9",
    printArea: `A1:${lastColumn}${Math.max(HEADER_ROW + 1, sheet.rowCount)}`,
  };
  sheet.headerFooter.oddFooter = "&LShwapno Visit Compliance Backup&CPage &P of &N&RGenerated &D &T";
}

function formatDataColumn(sheet, column, rowCount, numFmt) {
  for (let row = HEADER_ROW + 1; row <= HEADER_ROW + rowCount; row += 1) {
    sheet.getCell(row, column).numFmt = numFmt;
  }
}

function tablePeriod(visitRecords, auditRecords, fallback) {
  const dates = [];
  visitRecords.forEach(row => {
    if (row.plannedDate) dates.push(row.plannedDate);
    if (row.actualDate) dates.push(row.actualDate);
  });
  auditRecords.forEach(row => { if (row.date) dates.push(row.date); });
  if (!dates.length && fallback) dates.push(parseDate(fallback));
  const cleanDates = dates.filter(Boolean).sort((a, b) => a - b);
  return { from: cleanDates[0] || null, through: cleanDates.at(-1) || parseDate(fallback) || new Date() };
}

export async function buildCompiledBackupWorkbook({ data, auditRows, auditSource = "", generatedAt = new Date() }) {
  const ExcelJS = globalThis.ExcelJS;
  if (!ExcelJS?.Workbook) throw new Error("The Excel backup module did not load. Refresh the dashboard and try again.");
  if (!data?.officers || !data?.details) throw new Error("Visit Compliance data is not ready yet.");
  if (!Array.isArray(auditRows) || !auditRows.length) throw new Error("Audit backup data is not available yet. Open or refresh the Audit dashboard once, then try again.");

  const visitRecords = buildVisitRecords(data);
  const auditModel = buildAuditModel(auditRows, data);
  const period = tablePeriod(visitRecords, auditModel.records, data?.metadata?.snapshotDate);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Shwapno Visit Compliance Dashboard";
  workbook.lastModifiedBy = "Shwapno Visit Compliance Dashboard";
  workbook.created = generatedAt;
  workbook.modified = generatedAt;
  workbook.title = "Visit Compliance and Audit Compiled Backup";
  workbook.subject = "Beginning-to-date dashboard backup with two filterable sheets";
  workbook.company = "ACI Logistics Limited (Shwapno)";
  workbook.calcProperties.fullCalcOnLoad = true;
  workbook.calcProperties.forceFullCalc = true;

  const visitSheet = workbook.addWorksheet(VISIT_SHEET_NAME, { properties: { tabColor: { argb: COLORS.blue } } });
  const auditSheet = workbook.addWorksheet(AUDIT_SHEET_NAME, { properties: { tabColor: { argb: COLORS.amber } } });

  const auditHeaders = [
    "Month", "Audit Date", "Response ID", "Outlet Code", "Outlet Name", "Zonal", "Regional (RHO)",
    "Latest Audit", "Score Band", "Earned Points", "Available Points", "Points Lost", "Audit Score %",
    "Scored Questions", "Weakest Category", "Weakest Category Score %",
    ...auditModel.categoryNames.map(category => `${category} Score %`),
  ];
  const auditTableRows = auditModel.records.map(record => [
    monthStart(record.date),
    record.date,
    record.responseId,
    record.code,
    record.owner.name,
    record.owner.zonal,
    record.owner.rho,
    record.latest ? "Yes" : "No",
    scoreBand(record.score),
    record.earned,
    record.available,
    Math.max(0, record.available - record.earned),
    record.score == null ? null : record.score / 100,
    record.scoredQuestions,
    record.weakestCategory,
    record.weakestCategoryScore == null ? null : record.weakestCategoryScore / 100,
    ...auditModel.categoryNames.map(category => {
      const categoryTotal = record.categories.get(category);
      return categoryTotal?.available ? categoryTotal.earned / categoryTotal.available : null;
    }),
  ]);

  const auditLastColumn = lastColumnLetter(auditHeaders.length);
  styleTitle(
    auditSheet,
    auditHeaders.length,
    "Audit Quality — Compiled Backup",
    `All available audit responses: ${displayDate(period.from)} to ${displayDate(period.through)} · Latest-response scoring rule preserved · Source: ${auditSource || "Audit dashboard snapshot"}`,
  );
  const auditTotals = auditSummary(auditModel);
  addSummaryCards(auditSheet, [
    { label: "LATEST AUDITS", value: auditTotals.audits, fill: COLORS.bluePale, font: COLORS.blue },
    { label: "OUTLETS COVERED", value: auditTotals.outlets, fill: COLORS.bluePale, font: COLORS.blue },
    { label: "EARNED POINTS", value: auditTotals.earned, fill: COLORS.greenPale, font: COLORS.green },
    { label: "AVAILABLE POINTS", value: auditTotals.available, fill: COLORS.bluePale, font: COLORS.navySoft },
    { label: "POINTS LOST", value: auditTotals.pointsLost, fill: COLORS.redPale, font: COLORS.red },
    { label: "OVERALL AUDIT SCORE", value: auditTotals.score, numFmt: "0.0%", fill: COLORS.amberPale, font: COLORS.amber },
  ]);
  addNavigationNote(auditSheet, auditHeaders.length, "← Back to Visit Compliance. Filter Latest Audit = Yes to reproduce the dashboard scoring population.", "#'Visit Compliance'!A1");
  addTable(auditSheet, "AuditBackup", auditHeaders, auditTableRows, "TableStyleMedium9");
  setColumnWidths(auditSheet, [12, 20, 14, 13, 26, 23, 23, 13, 17, 14, 15, 13, 14, 16, 24, 20, ...auditModel.categoryNames.map(() => 22)]);
  formatDataColumn(auditSheet, 1, auditTableRows.length, "mmm yyyy");
  formatDataColumn(auditSheet, 2, auditTableRows.length, "dd-mmm-yy h:mm AM/PM");
  [10, 11, 12, 14].forEach(column => formatDataColumn(auditSheet, column, auditTableRows.length, "#,##0"));
  [13, 16, ...auditModel.categoryNames.map((_, index) => 17 + index)]
    .forEach(column => formatDataColumn(auditSheet, column, auditTableRows.length, "0.0%"));
  styleAuditRows(auditSheet, auditTableRows.length);
  setupSheet(auditSheet, auditLastColumn);

  const auditAnchorBySite = new Map();
  auditModel.records.forEach((record, index) => {
    if (record.latest && !auditAnchorBySite.has(record.code)) auditAnchorBySite.set(record.code, HEADER_ROW + 1 + index);
  });

  const visitHeaders = [
    "Month", "Officer Type", "Officer", "Outlet Code", "Outlet Name", "Zonal", "Regional (RHO)",
    "Planned Visit Date", "Visit Status", "In Time", "Out Time", "Visit Duration (min)",
    "Actual Visit Date", "Response ID", "Remarks", "Never Visited", "Audit Score %", "Open Audit",
    "Audit Points", "Latest Audit Date", "Audit Response ID",
  ];
  const visitTableRows = visitRecords.map(record => {
    const audit = auditModel.latestBySite.get(record.code);
    return [
      monthStart(record.plannedDate || record.actualDate),
      record.officerType,
      record.officer,
      record.code,
      record.outletName,
      record.owner.zonal,
      record.owner.rho,
      record.plannedDate,
      record.status,
      record.inTime,
      record.outTime,
      record.duration,
      record.actualDate,
      record.responseId,
      record.remarks,
      record.neverVisited ? "Yes" : "No",
      audit?.score == null ? null : audit.score / 100,
      null,
      audit?.available ? `${Math.round(audit.earned).toLocaleString("en-US")} / ${Math.round(audit.available).toLocaleString("en-US")}` : null,
      audit?.date || null,
      audit?.responseId || null,
    ];
  });

  styleTitle(
    visitSheet,
    visitHeaders.length,
    "Visit Compliance — Compiled Backup",
    `Beginning-to-date visit backup: ${displayDate(period.from)} to ${displayDate(period.through)} · Snapshot: ${displayDate(data?.metadata?.snapshotDate)} · Generated: ${generatedAt.toLocaleString("en-GB")}`,
  );
  const visitTotals = visitSummary(data);
  addSummaryCards(visitSheet, [
    { label: "PLANNED VISITS (TILL DATE)", value: visitTotals.planned, fill: COLORS.bluePale, font: COLORS.blue },
    { label: "COMPLETED VISITS", value: visitTotals.completed, fill: COLORS.greenPale, font: COLORS.green },
    { label: "PENDING VISITS", value: visitTotals.pending, fill: COLORS.redPale, font: COLORS.red },
    { label: "NEVER VISITED OUTLETS", value: visitTotals.never, fill: COLORS.amberPale, font: COLORS.amber },
    { label: "ACCEPTED RESPONSES", value: visitTotals.accepted, fill: COLORS.bluePale, font: COLORS.navySoft },
    { label: "VISIT COMPLETION %", value: visitTotals.completion, numFmt: "0.0%", fill: COLORS.greenPale, font: COLORS.green },
  ]);
  addNavigationNote(visitSheet, visitHeaders.length, "Click any Audit Score % below to open that outlet's latest audit. Use the table ▼ buttons to filter or sort by month, officer, outlet, status, ownership and score.", "#'Audit'!A1");
  addTable(visitSheet, "VisitComplianceBackup", visitHeaders, visitTableRows, "TableStyleMedium2");
  setColumnWidths(visitSheet, [12, 14, 25, 13, 26, 23, 23, 17, 18, 13, 13, 20, 17, 14, 25, 15, 15, 15, 16, 20, 17]);
  formatDataColumn(visitSheet, 1, visitTableRows.length, "mmm yyyy");
  formatDataColumn(visitSheet, 8, visitTableRows.length, "dd-mmm-yy");
  formatDataColumn(visitSheet, 10, visitTableRows.length, "h:mm AM/PM");
  formatDataColumn(visitSheet, 11, visitTableRows.length, "h:mm AM/PM");
  formatDataColumn(visitSheet, 12, visitTableRows.length, '0 "min"');
  formatDataColumn(visitSheet, 13, visitTableRows.length, "dd-mmm-yy");
  formatDataColumn(visitSheet, 17, visitTableRows.length, "0.0%");
  formatDataColumn(visitSheet, 20, visitTableRows.length, "dd-mmm-yy h:mm AM/PM");

  visitRecords.forEach((record, index) => {
    const audit = auditModel.latestBySite.get(record.code);
    const targetRow = auditAnchorBySite.get(record.code);
    if (!audit || audit.score == null || !targetRow) return;
    const row = HEADER_ROW + 1 + index;
    visitSheet.getCell(row, 18).value = {
      text: `${audit.score.toFixed(1)}% →`,
      hyperlink: `#'Audit'!A${targetRow}`,
      tooltip: `Open latest audit for ${record.code}`,
    };
  });
  styleVisitRows(visitSheet, visitTableRows.length, 17, 18);
  setupSheet(visitSheet, lastColumnLetter(visitHeaders.length));

  const buffer = await workbook.xlsx.writeBuffer();
  const through = isoDate(period.through) || isoDate(generatedAt);
  return {
    buffer,
    filename: `visit_compliance_audit_backup_through_${through}.xlsx`,
    stats: {
      visitRows: visitTableRows.length,
      auditRows: auditTableRows.length,
      auditAnswerRows: auditRows.length,
      auditCategories: auditModel.categoryNames.length,
      from: isoDate(period.from),
      through,
    },
  };
}

export async function downloadCompiledBackupWorkbook(options) {
  const result = await buildCompiledBackupWorkbook(options);
  const blob = new Blob([result.buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = result.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 4000);
  return result;
}
