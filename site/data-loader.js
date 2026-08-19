/*
 * Visit Compliance Dashboard data loader
 *
 * STRICT PC RAW-DATA MODE
 *
 * The dashboard reads the current workbooks only from the PC folder selected
 * by the user. Repository Excel/JSON files and previously calculated dashboard
 * snapshots are not used as a data source. The browser may remember only the
 * folder handle so it can reopen the same local folder after permission is
 * granted.
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
const PC_READER_VERSION = "pc-raw-folder-v7";

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

function excelSerialToIso(value, date1904 = false) {
  const serial = Number(value);
  if (!Number.isFinite(serial)) return null;
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const probe = new Date(epoch + serial * 86400000);
  if (Number.isNaN(probe.getTime())) return null;
  return isoDate(probe.getUTCFullYear(), probe.getUTCMonth() + 1, probe.getUTCDate());
}

function parseDateOnly(value, date1904 = false) {
  if (value == null || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return isoDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return excelSerialToIso(value, date1904);
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
  if (!globalThis.XLSX) throw new Error("The built-in Excel reader did not load. Refresh the page once and try again.");
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

async function readResponseWorkbookWithSheetJs(file) {
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

/*
 * Fast .xlsx response reader
 *
 * SheetJS is retained for schedules and legacy .xls/.xlsm files.  A current
 * response export, however, can contain tens of thousands of rows and many
 * large answer tabs.  Even when SheetJS is asked for one tab, opening that
 * workbook can keep the browser on "Reading" for several minutes.
 *
 * This reader opens the ZIP directory directly from the selected PC file,
 * fetches only the four parts needed for Response Summary, and extracts just
 * the five dashboard columns.  It never reads the answer/detail tabs.
 */
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_METHOD_STORED = 0;
const ZIP_METHOD_DEFLATE = 8;
const ZIP_TAIL_BYTES = 1024 * 1024;
let DEFLATE_RAW_SUPPORTED = null;

function supportsDeflateRaw() {
  if (DEFLATE_RAW_SUPPORTED != null) return DEFLATE_RAW_SUPPORTED;
  if (typeof DecompressionStream !== "function") {
    DEFLATE_RAW_SUPPORTED = false;
    return false;
  }
  try {
    // Some Chromium-family browsers expose DecompressionStream but do not
    // implement the deflate-raw format used by .xlsx ZIP entries.
    new DecompressionStream("deflate-raw");
    DEFLATE_RAW_SUPPORTED = true;
  } catch {
    DEFLATE_RAW_SUPPORTED = false;
  }
  return DEFLATE_RAW_SUPPORTED;
}

function zipDataView(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function zipDecode(bytes) {
  return new TextDecoder("utf-8").decode(bytes);
}

function zipNormalizePath(path) {
  const parts = String(path || "").replace(/\\/g, "/").split("/");
  const clean = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") clean.pop();
    else clean.push(part);
  }
  return clean.join("/");
}

function zipEndOfCentralDirectory(bytes) {
  const view = zipDataView(bytes);
  for (let index = bytes.length - 22; index >= 0; index -= 1) {
    if (view.getUint32(index, true) === ZIP_EOCD_SIGNATURE) return index;
  }
  throw new Error("The selected .xlsx file is not a valid Excel ZIP workbook.");
}

function zipXmlDecode(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(parseInt(value, 16)))
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function zipXmlAttribute(tag, attribute) {
  const escaped = String(attribute).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(tag).match(new RegExp("(?:^|\\s)" + escaped + '="([^"]*)"', "i"));
  return match ? zipXmlDecode(match[1]) : "";
}

function zipTextContent(fragment) {
  const pieces = [];
  const textPattern = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gi;
  let match;
  while ((match = textPattern.exec(fragment))) pieces.push(match[1]);
  return zipXmlDecode(pieces.length ? pieces.join("") : String(fragment).replace(/<[^>]+>/g, ""));
}

class LocalXlsxZip {
  constructor(file, entries) {
    this.file = file;
    this.entries = entries;
  }

  has(path) {
    return this.entries.has(zipNormalizePath(path));
  }

  async stream(path) {
    const entry = this.entries.get(zipNormalizePath(path));
    if (!entry) throw new Error("The selected workbook is missing " + path + ".");
    if (entry.encrypted) throw new Error("Password-protected Excel files cannot be read by the dashboard.");
    const headerBytes = new Uint8Array(await this.file.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
    const header = zipDataView(headerBytes);
    if (headerBytes.byteLength < 30 || header.getUint32(0, true) !== ZIP_LOCAL_SIGNATURE) {
      throw new Error("The selected workbook has an invalid ZIP entry.");
    }
    const nameLength = header.getUint16(26, true);
    const extraLength = header.getUint16(28, true);
    const dataStart = entry.localOffset + 30 + nameLength + extraLength;
    const rawStream = this.file.slice(dataStart, dataStart + entry.compressedSize).stream();
    if (entry.method === ZIP_METHOD_STORED) return rawStream;
    if (entry.method !== ZIP_METHOD_DEFLATE || typeof DecompressionStream !== "function") {
      throw new Error("This .xlsx compression method is not supported by the fast PC reader.");
    }
    return rawStream.pipeThrough(new DecompressionStream("deflate-raw"));
  }

  async bytes(path) {
    return new Uint8Array(await new Response(await this.stream(path)).arrayBuffer());
  }

  async text(path) {
    return zipDecode(await this.bytes(path));
  }
}

async function openLocalXlsxZip(file) {
  if (!/\.xlsx$/i.test(file?.name || "") || !supportsDeflateRaw() || !file?.slice) return null;
  const tailLength = Math.min(Number(file.size) || 0, ZIP_TAIL_BYTES);
  if (!tailLength) throw new Error("The selected response workbook is empty.");
  const tailStart = Math.max(0, file.size - tailLength);
  const tail = new Uint8Array(await file.slice(tailStart).arrayBuffer());
  const eocdOffset = zipEndOfCentralDirectory(tail);
  const eocd = zipDataView(tail);
  const disk = eocd.getUint16(eocdOffset + 4, true);
  const centralDisk = eocd.getUint16(eocdOffset + 6, true);
  const centralSize = eocd.getUint32(eocdOffset + 12, true);
  const centralOffset = eocd.getUint32(eocdOffset + 16, true);
  if (disk !== 0 || centralDisk !== 0 || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    throw new Error("This ZIP64 or multi-disk Excel file cannot be read by the dashboard.");
  }
  const central = new Uint8Array(await file.slice(centralOffset, centralOffset + centralSize).arrayBuffer());
  const view = zipDataView(central);
  const entries = new Map();
  let offset = 0;
  while (offset + 46 <= central.byteLength && view.getUint32(offset, true) === ZIP_CENTRAL_SIGNATURE) {
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > central.byteLength) throw new Error("The Excel ZIP directory is invalid.");
    const name = zipNormalizePath(zipDecode(central.subarray(nameStart, nameEnd)));
    entries.set(name, {
      method,
      encrypted: Boolean(flags & 0x0001),
      compressedSize,
      localOffset,
    });
    offset = nameEnd + extraLength + commentLength;
  }
  if (!entries.has("xl/workbook.xml") || !entries.has("xl/_rels/workbook.xml.rels")) {
    throw new Error("The selected file is not a valid .xlsx workbook.");
  }
  return new LocalXlsxZip(file, entries);
}

function workbookSheetReferences(workbookXml, relationshipsXml) {
  const relationships = new Map();
  const relationshipPattern = /<Relationship\b([^>]*)\/?>(?:<\/Relationship>)?/gi;
  let relationshipMatch;
  while ((relationshipMatch = relationshipPattern.exec(relationshipsXml))) {
    const attributes = relationshipMatch[1];
    const id = zipXmlAttribute(attributes, "Id");
    const target = zipXmlAttribute(attributes, "Target");
    if (id && target) relationships.set(id, target);
  }
  const sheets = new Map();
  const sheetPattern = /<sheet\b([^>]*)\/?>(?:<\/sheet>)?/gi;
  let sheetMatch;
  while ((sheetMatch = sheetPattern.exec(workbookXml))) {
    const attributes = sheetMatch[1];
    const name = zipXmlAttribute(attributes, "name");
    const relationshipId = zipXmlAttribute(attributes, "r:id");
    const target = relationships.get(relationshipId);
    if (!name || !target) continue;
    const path = target.startsWith("/") ? zipNormalizePath(target) : zipNormalizePath("xl/" + target.replace(/^\.\//, ""));
    sheets.set(nameKey(name), { name, path });
  }
  return sheets;
}

function workbookUses1904Dates(workbookXml) {
  const tag = workbookXml.match(/<workbookPr\b([^>]*)\/?>(?:<\/workbookPr>)?/i)?.[1] || "";
  const value = zipXmlAttribute(tag, "date1904");
  return /^(?:1|true)$/i.test(value);
}

function sharedStringToken(value) {
  return value && typeof value === "object" && Number.isInteger(value.sharedIndex) ? value.sharedIndex : null;
}

function tokenValue(attributes, contents) {
  const type = zipXmlAttribute(attributes, "t");
  if (type === "inlineStr") return zipTextContent(contents.match(/<is(?:\s[^>]*)?>([\s\S]*?)<\/is>/i)?.[1] || "");
  const raw = contents.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/i)?.[1];
  if (raw == null) return "";
  const value = zipXmlDecode(raw);
  if (type === "s") return { sharedIndex: Number(value) };
  if ((!type || type === "n") && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return Number(value);
  return value;
}

function worksheetCellTokens(rowContents, wantedColumns = null) {
  const cells = new Map();
  const cellPattern = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/gi;
  let match;
  while ((match = cellPattern.exec(rowContents))) {
    const attributes = match[1] || match[3] || "";
    const column = cellColumn(attributes);
    if (column >= 0 && (!wantedColumns || wantedColumns.has(column))) {
      cells.set(column, tokenValue(attributes, match[2] || ""));
    }
  }
  return cells;
}

function collectSharedIndices(cells, target) {
  cells.forEach((value) => {
    const index = sharedStringToken(value);
    if (index != null && index >= 0) target.add(index);
  });
}

function resolveToken(value, sharedStrings) {
  const index = sharedStringToken(value);
  return index == null ? value : (sharedStrings.get(index) ?? "");
}

async function readSharedStringsForIndices(zip, indices) {
  const wanted = new Set([...indices].filter((value) => Number.isInteger(value) && value >= 0));
  const resolved = new Map();
  if (!wanted.size) return resolved;
  if (!zip.has("xl/sharedStrings.xml")) throw new Error("The Excel workbook references shared strings but has no sharedStrings.xml file.");

  const reader = (await zip.stream("xl/sharedStrings.xml")).getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let itemIndex = 0;
  let done = false;
  try {
    while (!done && resolved.size < wanted.size) {
      const chunk = await reader.read();
      done = chunk.done;
      if (chunk.value) buffer += decoder.decode(chunk.value, { stream: !done });
      if (done) buffer += decoder.decode();

      while (true) {
        const start = buffer.indexOf("<si");
        if (start < 0) {
          if (buffer.length > 32) buffer = buffer.slice(-32);
          break;
        }
        const openEnd = buffer.indexOf(">", start);
        if (openEnd < 0) {
          if (start > 0) buffer = buffer.slice(start);
          break;
        }
        const close = buffer.indexOf("</si>", openEnd + 1);
        if (close < 0) {
          if (start > 0) buffer = buffer.slice(start);
          break;
        }
        if (wanted.has(itemIndex)) {
          resolved.set(itemIndex, zipTextContent(buffer.slice(openEnd + 1, close)));
        }
        itemIndex += 1;
        buffer = buffer.slice(close + 5);
        if (resolved.size >= wanted.size) break;
      }
    }
  } finally {
    if (resolved.size >= wanted.size) {
      try { await reader.cancel(); } catch { /* no-op */ }
    }
  }
  for (const index of wanted) {
    if (!resolved.has(index)) resolved.set(index, "");
  }
  return resolved;
}

function firstRowContents(sheetXml) {
  const match = sheetXml.match(/<row\b[^>]*>([\s\S]*?)<\/row>/i);
  return match ? match[1] : null;
}

async function resolvedHeaderMap(zip, sheetXml) {
  const contents = firstRowContents(sheetXml);
  if (contents == null) return new Map();
  const tokens = worksheetCellTokens(contents);
  const indices = new Set();
  collectSharedIndices(tokens, indices);
  const shared = await readSharedStringsForIndices(zip, indices);
  const map = new Map();
  tokens.forEach((value, column) => {
    const label = cleanText(resolveToken(value, shared));
    if (label) map.set(label, column);
  });
  return map;
}

function browserYield() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function responseWorksheetReference(workbookXml, relationshipsXml) {
  const responseSheet = workbookSheetReferences(workbookXml, relationshipsXml).get(nameKey(RESPONSE_SHEET));
  if (!responseSheet) throw new Error('The selected workbook does not contain the "Response Summary" sheet.');
  return responseSheet.path;
}

function sharedStringValues(sharedStringsXml) {
  const values = [];
  const itemPattern = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/gi;
  let match;
  while ((match = itemPattern.exec(sharedStringsXml))) values.push(zipTextContent(match[1]));
  return values;
}

function cellColumn(attributes) {
  const reference = zipXmlAttribute(attributes, "r");
  const letters = reference.match(/^([A-Z]+)\d+$/i)?.[1];
  if (!letters) return -1;
  return [...letters.toUpperCase()].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function cellValue(attributes, contents, sharedStrings) {
  const type = zipXmlAttribute(attributes, "t");
  if (type === "inlineStr") return zipTextContent(contents.match(/<is(?:\s[^>]*)?>([\s\S]*?)<\/is>/i)?.[1] || "");
  const raw = contents.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/i)?.[1];
  if (raw == null) return "";
  const value = zipXmlDecode(raw);
  if (type === "s") return sharedStrings[Number(value)] ?? "";
  if ((!type || type === "n") && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return Number(value);
  return value;
}

function worksheetCells(rowContents, sharedStrings, wantedColumns = null) {
  const cells = new Map();
  const cellPattern = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/gi;
  let match;
  while ((match = cellPattern.exec(rowContents))) {
    const attributes = match[1] || match[3] || "";
    const column = cellColumn(attributes);
    if (column >= 0 && (!wantedColumns || wantedColumns.has(column))) {
      cells.set(column, cellValue(attributes, match[2] || "", sharedStrings));
    }
  }
  return cells;
}

async function parseFastResponseSummary(zip, sheetXml) {
  const headerMap = await resolvedHeaderMap(zip, sheetXml);
  if (!headerMap.size) throw new Error('"Response Summary" is empty.');
  for (const column of RESPONSE_HEADERS) {
    if (!headerMap.has(column)) throw new Error('"Response Summary" is missing the "' + column + '" column.');
  }

  const wantedColumns = new Set([
    headerMap.get("Response ID"),
    headerMap.get("Date"),
    headerMap.get("Site Code"),
    headerMap.get("Created By User ID"),
  ]);
  const rowPattern = /<row\b[^>]*>([\s\S]*?)<\/row>/gi;
  const tokenRows = [];
  const sharedNeeded = new Set();
  let rowMatch;
  let rowNumber = 0;
  while ((rowMatch = rowPattern.exec(sheetXml))) {
    rowNumber += 1;
    if (rowNumber === 1) continue;
    const row = worksheetCellTokens(rowMatch[1], wantedColumns);
    collectSharedIndices(row, sharedNeeded);
    tokenRows.push(row);
    if (rowNumber % 5000 === 0) await browserYield();
  }
  const shared = await readSharedStringsForIndices(zip, sharedNeeded);

  const accepted = [];
  const seenIds = new Set();
  let duplicateIds = 0;
  let rejectedRows = 0;
  for (let index = 0; index < tokenRows.length; index += 1) {
    const row = tokenRows[index];
    const get = (header) => resolveToken(row.get(headerMap.get(header)), shared);
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
    if (index && index % 10000 === 0) await browserYield();
  }
  if (!accepted.length) throw new Error('"Response Summary" has no accepted response rows.');
  return {
    responses: accepted,
    diagnostics: { duplicateResponseIdsIgnored: duplicateIds, rejectedResponseRows: rejectedRows },
  };
}

async function readResponseWorkbookFast(file) {
  const zip = await openLocalXlsxZip(file);
  if (!zip) return null;
  const [workbookXml, relationshipsXml] = await Promise.all([
    zip.text("xl/workbook.xml"),
    zip.text("xl/_rels/workbook.xml.rels"),
  ]);
  const worksheetPath = responseWorksheetReference(workbookXml, relationshipsXml);
  const sheetXml = await zip.text(worksheetPath);
  return parseFastResponseSummary(zip, sheetXml);
}

async function readResponseWorkbook(file) {
  // Prefer the selective ZIP reader because it never opens answer/detail tabs.
  // If the browser cannot decode raw DEFLATE (or a workbook uses an unusual
  // ZIP layout), fall back to the bundled SheetJS reader instead of failing.
  try {
    const fast = await readResponseWorkbookFast(file);
    if (fast) return fast;
  } catch {
    // Compatibility fallback below.
  }
  return readResponseWorkbookWithSheetJs(file);
}

async function readScheduleWorkbookFast(file) {
  const zip = await openLocalXlsxZip(file);
  if (!zip) return null;
  const [workbookXml, relationshipsXml] = await Promise.all([
    zip.text("xl/workbook.xml"),
    zip.text("xl/_rels/workbook.xml.rels"),
  ]);
  const sheetRefs = workbookSheetReferences(workbookXml, relationshipsXml);
  const date1904 = workbookUses1904Dates(workbookXml);
  const assignments = [];
  const outlets = {};
  const seen = new Set();
  let usableSheets = 0;

  for (const schema of SCHEDULE_SCHEMAS) {
    const ref = sheetRefs.get(nameKey(schema.sheet));
    if (!ref) continue;
    const sheetXml = await zip.text(ref.path);
    const headerMap = await resolvedHeaderMap(zip, sheetXml);
    if (!headerMap.size) throw new Error("Schedule sheet " + schema.sheet + " is empty.");
    for (const label of ["SL", "CODE", "Outlet Name", schema.officerHeader]) {
      if (!headerMap.has(label)) throw new Error("Schedule sheet " + schema.sheet + ' is missing "' + label + '".');
    }

    const headerContents = firstRowContents(sheetXml) || "";
    const headerTokens = worksheetCellTokens(headerContents);
    const headerSharedNeeded = new Set();
    collectSharedIndices(headerTokens, headerSharedNeeded);
    const headerShared = await readSharedStringsForIndices(zip, headerSharedNeeded);
    const dateColumns = [];
    headerTokens.forEach((value, column) => {
      const label = cleanText(resolveToken(value, headerShared));
      if (!label || ["SL", "CODE", "Outlet Name", schema.officerHeader].includes(label)) return;
      const parsed = parseDateOnly(resolveToken(value, headerShared), date1904);
      if (parsed) dateColumns.push([column, parsed]);
    });
    if (!dateColumns.length) throw new Error("No visit-date columns were found in " + schema.sheet + ".");

    const wantedColumns = new Set([
      headerMap.get("CODE"),
      headerMap.get("Outlet Name"),
      headerMap.get(schema.officerHeader),
      ...dateColumns.map(([column]) => column),
    ]);
    const rowPattern = /<row\b[^>]*>([\s\S]*?)<\/row>/gi;
    const tokenRows = [];
    const sharedNeeded = new Set();
    let rowMatch;
    let rowNumber = 0;
    while ((rowMatch = rowPattern.exec(sheetXml))) {
      rowNumber += 1;
      if (rowNumber === 1) continue;
      const row = worksheetCellTokens(rowMatch[1], wantedColumns);
      collectSharedIndices(row, sharedNeeded);
      tokenRows.push(row);
      if (rowNumber % 3000 === 0) await browserYield();
    }
    const shared = await readSharedStringsForIndices(zip, sharedNeeded);

    tokenRows.forEach((row, rowIndex) => {
      const get = (label) => resolveToken(row.get(headerMap.get(label)), shared);
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
        if (nameKey(resolveToken(row.get(column), shared)) !== "yes") return;
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
    usableSheets += 1;
    await browserYield();
  }
  if (!usableSheets) throw new Error("The workbook does not contain the Zonal or RHO visit-plan sheets.");
  if (!assignments.length) throw new Error("No planned visits were found in the local schedule workbook.");
  return { assignments, outlets, fileName: file.name };
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

async function readScheduleWorkbookWithSheetJs(file) {
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

async function readScheduleWorkbook(file) {
  try {
    const fast = await readScheduleWorkbookFast(file);
    if (fast) return fast;
  } catch {
    // Compatibility fallback below.
  }
  return readScheduleWorkbookWithSheetJs(file);
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
  const assignmentsByOfficer = new Map();
  const dueByOfficer = new Map();
  const responsesByOfficer = new Map();
  const pushGrouped = (map, key, value) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  };
  schedule.assignments.forEach((assignment) => pushGrouped(assignmentsByOfficer, assignment.officerKey, assignment));
  due.forEach((assignment) => pushGrouped(dueByOfficer, assignment.officerKey, assignment));
  responses.forEach((response) => pushGrouped(responsesByOfficer, response.officerKey, response));

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
    const full = assignmentsByOfficer.get(officerKey) || [];
    const dueOfficer = dueByOfficer.get(officerKey) || [];
    const officerResponses = responsesByOfficer.get(officerKey) || [];
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
      localReaderVersion: PC_READER_VERSION,
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

function isTargetResponseFilename(file) {
  // The operational export is expected to be named like:
  // Store_Operations_Compliance_Audit_responses_2026-08-19.xlsx
  // Allow spaces / hyphens / underscores between the fixed words, but do not
  // scan unrelated workbooks in the selected folder.
  const stem = String(file?.name || "").replace(/\.(xlsx|xlsm|xls)$/i, "");
  return /^store[\s_-]*operations[\s_-]*compliance[\s_-]*audit[\s_-]*responses?(?:[\s_-]|$)/i.test(stem);
}

function responseFilePriority(file) {
  return isTargetResponseFilename(file) ? 0 : 99;
}

function scheduleFilePriority(file) {
  const name = nameKey(file?.name);
  if (/master.*compiled.*visit|compiled.*visit|visit.*schedule/.test(name)) return 0;
  if (/\bschedule\b|\bvisit\s*plan\b|\bplan\b/.test(name)) return 1;
  return 99;
}

function orderFilesByPriority(files, priority) {
  return [...files].sort((a, b) =>
    priority(a) - priority(b)
    || b.lastModified - a.lastModified
    || a.name.localeCompare(b.name)
  );
}

async function findResponseFile(files) {
  const candidates = orderFilesByPriority(
    files.filter(isTargetResponseFilename),
    responseFilePriority,
  );
  if (!candidates.length) {
    throw new Error('No workbook named like "Store_Operations_Compliance_Audit_responses...xlsx" was found in the selected PC raw-data folder.');
  }

  // Use the newest matching local response export only.  We deliberately do
  // not probe the visit-plan workbook or any repository file.
  const file = candidates[0];
  try {
    const parsed = await readResponseWorkbook(file);
    return { file, parsed };
  } catch (error) {
    throw new Error(file.name + ': ' + (error?.message || 'Could not read the Response Summary sheet.'));
  }
}

async function findScheduleFile(files, responseFile) {
  const candidates = files.filter((file) => file !== responseFile && scheduleFilePriority(file) < 99);
  const ordered = orderFilesByPriority(candidates, scheduleFilePriority);
  for (const file of ordered) {
    try {
      return { file, schedule: await readScheduleWorkbook(file) };
    } catch {
      // Try the next local visit-plan candidate only. Unrelated workbooks are
      // intentionally never scanned.
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
    this.watchAllowed = false;
    this.lastStatusKey = "";
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
    // Remember only the folder handle. Never restore old calculated data.
    this.dirHandle = await pcDbGet("handles", "folder");
    try { await pcDbPut("snapshots", "latest", null); } catch { /* no-op */ }
    this.currentData = null;
    this.currentSignature = "";
    this.currentFolderSignature = "";
    this.savedAt = null;
    return null;
  }

  attach({ baseData, onData, onStatus }) {
    this.baseData = baseData;
    this.onData = onData;
    this.onStatus = onStatus;
    this.bindControls();
    // A remembered folder is checked once on startup.  Continuous watching is
    // enabled only after the browser confirms read permission and a usable
    // local snapshot exists.  This prevents the 5-second status flashing that
    // occurred when a folder was unreadable or a workbook parse failed.
    this.refreshFolder({ silent: true }).then(() => {
      if (this.watchAllowed && this.currentData) this.startWatching();
    }).catch(() => {});
  }

  setStatus(status) {
    const key = String(status?.kind || "") + "|" + String(status?.message || "");
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    if (this.onStatus) this.onStatus(status);
  }

  sendData(data, source, usingLastData, status) {
    this.currentData = data;
    this.savedAt = data.metadata?.snapshotTakenAt || new Date().toISOString();
    if (this.onData) this.onData(this.result(data, source, usingLastData, status));
  }

  async saveLatest(data, signature, folderStateSignature = "") {
    // Keep only the current-session result.  Strict PC-folder mode never
    // persists calculated dashboard data for use on a later page load.
    this.currentData = data;
    this.currentSignature = signature;
    this.currentFolderSignature = folderStateSignature;
    this.savedAt = data.metadata?.snapshotTakenAt || new Date().toISOString();
  }

  bindControls() {
    const grant = document.getElementById("grant-folder");
    const folder = document.getElementById("pick-folder");
    const folderFallback = document.getElementById("pick-folder-fallback");
    const folderFallbackButton = document.getElementById("pick-folder-fallback-btn");
    grant?.addEventListener("click", () => this.grantFolder());
    folder?.addEventListener("click", () => this.pickFolder());
    folderFallbackButton?.addEventListener("click", () => folderFallback?.click());
    folderFallback?.addEventListener("change", () => {
      const files = [...(folderFallback.files || [])];
      folderFallback.value = "";
      if (files.length) this.useFolderFiles(files);
    });
  }

  async pickFolder() {
    const fallbackButton = document.getElementById("pick-folder-fallback-btn");
    if (!window.showDirectoryPicker) {
      if (fallbackButton) fallbackButton.hidden = false;
      this.setStatus({ kind: "needs-folder-fallback", message: "This browser cannot keep direct folder access. Click Open folder (compatibility) and choose the same raw-data folder." });
      return;
    }
    try {
      this.stopWatching();
      const handle = await window.showDirectoryPicker({ id: "visit-compliance-raw-data", mode: "read" });
      this.dirHandle = handle;
      this.currentSignature = "";
      this.currentFolderSignature = "";
      this.watchAllowed = false;
      await pcDbPut("handles", "folder", handle);
      await this.refreshFolder({ silent: false });
      if (this.watchAllowed && this.currentData) this.startWatching();
    } catch (error) {
      if (error?.name === "AbortError") return;
      if (fallbackButton) fallbackButton.hidden = false;
      this.setStatus({ kind: "error", message: (error?.message || "Could not open the selected folder.") + " You can also use Open folder (compatibility)." });
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
        if (this.watchAllowed && this.currentData) this.startWatching();
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

  fallback(reason, kind = "error") {
    if (!this.currentData) return false;
    // The currently displayed data came from the selected local folder in
    // this same browser session. Keep it visible, but never re-label it as a
    // saved/repository copy.
    this.setStatus({ kind, message: reason });
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
      this.watchAllowed = false;
      this.stopWatching();
      document.getElementById("grant-folder").hidden = false;
      const message = "The browser needs one click to reopen your remembered PC folder.";
      if (!this.fallback(message, "needs-grant")) this.setStatus({ kind: "needs-grant", message });
      return;
    }
    this.watchAllowed = true;
    document.getElementById("grant-folder").hidden = true;
    try {
      const showProgress = !silent || !this.currentData;
      if (showProgress) {
        this.setStatus({ kind: "reading", message: "Scanning the selected PC raw-data folder…" });
        await browserYield();
      }
      const files = await folderWorkbookFiles(this.dirHandle);
      const currentFolderSignature = folderSignature(files);

      // A silent background check must stay visually silent when the folder
      // has not changed.  The previous v5 code changed the badge to “Reading”
      // and back every five seconds, which looked like the dashboard was
      // blinking even though nothing had changed.
      if (this.currentData && currentFolderSignature === this.currentFolderSignature) {
        if (!silent) this.setStatus({ kind: "live", message: "Live from the selected PC raw-data folder. Response Summary only; repository data is ignored." });
        return;
      }

      this.setStatus({ kind: "reading", message: "Finding Store_Operations_Compliance_Audit_responses… and reading Response Summary only…" });
      await browserYield();
      if (!files.length) throw new Error("The selected PC raw-data folder is empty.");
      const responseSource = await findResponseFile(files);
      this.setStatus({ kind: "reading", message: "Response Summary loaded (" + responseSource.parsed.responses.length.toLocaleString() + " responses). Reading the Zonal/RHO visit plan…" });
      await browserYield();
      const scheduleSource = await findScheduleFile(files, responseSource.file);
      const signature = fileSignature(responseSource.file) + "|" + (scheduleSource ? fileSignature(scheduleSource.file) : "retained-plan");
      if (signature === this.currentSignature && this.currentData) {
        this.currentFolderSignature = currentFolderSignature;
        this.setStatus({ kind: "live", message: "Live from the selected PC raw-data folder. Response Summary only; repository data is ignored." });
        return;
      }
      this.setStatus({ kind: "reading", message: "Reading Response Summary directly from " + responseSource.file.name + " (answer tabs are skipped)…" });
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
      // If the first local read fails, do not keep retrying every few seconds.
      // Show one stable error until the user chooses the folder again.
      if (!this.currentData) {
        this.watchAllowed = false;
        this.stopWatching();
      }
      if (!this.fallback(message)) this.setStatus({ kind: "error", message });
    }
  }

  async useFolderFiles(fileList) {
    try {
      this.stopWatching();
      this.watchAllowed = false;
      this.dirHandle = null;
      await pcDbPut("handles", "folder", null);
      const files = [...fileList]
        .filter((file) => file && !String(file.name || "").startsWith("~$") && /\.(xlsx|xlsm|xls)$/i.test(file.name || ""))
        .sort((a, b) => b.lastModified - a.lastModified || a.name.localeCompare(b.name));
      if (!files.length) throw new Error("No Excel workbook was found in the selected folder.");
      this.setStatus({ kind: "reading", message: "Reading the selected PC folder…" });
      await browserYield();
      const responseSource = await findResponseFile(files);
      const scheduleSource = await findScheduleFile(files, responseSource.file);
      const signature = fileSignature(responseSource.file) + "|" + (scheduleSource ? fileSignature(scheduleSource.file) : "retained-plan");
      await this.applyResponseFile(
        responseSource.file,
        "pc-folder-selection",
        scheduleSource?.file || null,
        signature,
        responseSource.parsed,
        scheduleSource?.schedule || null,
        folderSignature(files),
      );
    } catch (error) {
      const message = error?.message || "Could not read the selected PC folder.";
      if (!this.fallback(message)) this.setStatus({ kind: "error", message });
    }
  }


  async applyResponseFile(responseFile, source, scheduleFile, signature, parsedResponse = null, parsedSchedule = null, folderStateSignature = "") {
    const responseData = parsedResponse || await readResponseWorkbook(responseFile);
    let schedule;
    if (scheduleFile) {
      this.setStatus({ kind: "reading", message: "Reading the visit plan after Response Summary was loaded…" });
      schedule = parsedSchedule || await readScheduleWorkbook(scheduleFile);
      schedule.isRaw = true;
    } else {
      throw new Error("No Visit Schedule workbook was found in the selected PC raw-data folder. Keep the current Visit Schedule workbook in the same folder as the Store_Operations_Compliance_Audit_responses workbook.");
    }
    const baseline = this.currentData || this.baseData;
    this.setStatus({ kind: "reading", message: "Calculating dashboard from the loaded Response Summary and visit plan…" });
    await browserYield();
    const data = calculateLocalDashboard(baseline, schedule, responseData, responseFile, source);
    this.setStatus({ kind: "reading", message: "Dashboard calculated. Saving the local snapshot…" });
    await browserYield();
    await this.saveLatest(data, signature, folderStateSignature);
    this.sendData(data, source, false, {
      kind: "live",
      message: source === "pc-folder"
        ? "Live from your selected PC raw-data folder. Only the Response Summary sheet is read."
        : source === "pc-folder-selection"
          ? "Loaded from the selected PC raw-data folder. Use Change folder again whenever the raw files are replaced."
          : "Live from the response workbook selected on your PC. The snapshot is saved in this browser.",
    });
  }

  startWatching() {
    if (!this.dirHandle || !this.watchAllowed || !this.currentData || this.watchTimer) return;
    this.watchTimer = window.setInterval(() => {
      if (!document.hidden) this.refreshFolder({ silent: true });
    }, 10000);
    if (!this.boundVisibility) {
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden && this.watchAllowed && this.currentData) this.refreshFolder({ silent: true });
      });
      this.boundVisibility = true;
    }
  }

  stopWatching() {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
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
      message: "Choose your PC raw-data folder. The dashboard will read the local Store_Operations_Compliance_Audit_responses workbook (Response Summary only) and the local Visit Schedule workbook. Repository data is ignored.",
    },
    localSource,
  };
}

export function attachPcRawDataSource(localSource, options) {
  if (localSource) localSource.attach(options);
}

export function getDataStatus(result) {
  if (result?.source === "pc-folder") return { type: "pc-folder", text: "Showing a live snapshot from the selected PC raw-data folder." };
  if (result?.source === "pc-folder-selection") return { type: "pc-folder-selection", text: "Showing data loaded from the selected PC raw-data folder." };
  if (result?.source === "pc-file") return { type: "pc-file", text: "Showing a live snapshot from the response workbook selected on this PC." };
  return { type: "awaiting-local", text: "Choose your PC raw-data folder to load the current local workbooks." };
}
