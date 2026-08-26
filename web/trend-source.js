/* ═══════════════════════════════════════════════════════════════════════════
   trend-source.js — reads the workbook named "Trend" and nothing else.

   This module is deliberately isolated. It returns trend rows to app.js but
   never writes to the Visit Compliance data object, and it is not loaded by
   audit.html. Trend data is therefore unavailable to every compliance and
   audit calculation by construction.

   Expected columns (case-insensitive, any order, extra columns ignored;
   spaces, underscores and punctuation inside headers are ignored):
     Outlet Code   — or Site Code / Store Code / Code / Outlet
     Date          — the visit date
     Score         — total visit score for the day (or Total / Total Score)
   Optional:
     Outlet Name
     Time          — or Visit Time / Response Time / Timestamp
     Max           — or Max Score / Out Of / Total Marks / Full Marks
   ═══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  const LAST_N = 6;
  const EXCEL_EXTENSION = /\.(xlsx|xlsm)$/i;
  const FILE_NAME_MATCH = /(^|[\\/])trend\.(xlsx|xlsm)$/i;
  const HEADERS = Object.freeze({
    code: ["outletcode", "sitecode", "storecode", "outletid", "siteid", "outlet", "code"],
    name: ["outletname", "storename", "sitename", "name"],
    date: [
      "date", "visitdate", "auditdate", "responsedate", "visiteddate",
      "datetime", "visitdatetime", "responsedatetime", "timestamp",
      "submissiondate", "submitteddate", "submittedat", "createdat", "recordedat",
    ],
    time: [
      "time", "visittime", "audittime", "responsetime", "submissiontime",
      "submittedtime", "recordedtime", "completiontime", "completedtime",
      "timestamp", "datetime", "visitdatetime", "responsedatetime",
      "submissiondatetime", "submittedat", "createdat", "recordedat",
    ],
    score: [
      "score", "totalscore", "visitscore", "auditscore", "obtainedscore",
      "achievedscore", "scoreobtained", "total",
    ],
    max: [
      "max", "maxscore", "maximumscore", "outof", "totalmarks", "fullmarks",
      "totalpossible", "available",
    ],
  });

  const clean = (value) => String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
  const headerKey = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
  const pad2 = (value) => String(value).padStart(2, "0");

  function isoDate(year, month, day) {
    const y = Number(year);
    const m = Number(month);
    const d = Number(day);
    if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return "";
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() + 1 !== m || probe.getUTCDate() !== d) return "";
    return `${y}-${pad2(m)}-${pad2(d)}`;
  }

  function excelSerialToIso(value, date1904 = false) {
    const serial = Number(value);
    if (!Number.isFinite(serial)) return "";
    const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
    const probe = new Date(epoch + Math.floor(serial) * 86400000);
    return isoDate(probe.getUTCFullYear(), probe.getUTCMonth() + 1, probe.getUTCDate());
  }

  function toIsoDate(value, date1904 = false) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return isoDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return excelSerialToIso(value, date1904);
    }
    const text = clean(value);
    if (!text) return "";

    const serial = Number(text);
    if (Number.isFinite(serial) && serial > 20000 && serial < 80000) {
      return excelSerialToIso(serial, date1904);
    }

    let match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/);
    if (match) return isoDate(match[1], match[2], match[3]);

    match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[ T].*)?$/);
    if (match) {
      const month = Number(match[1]);
      const day = Number(match[2]);
      let year = Number(match[3]);
      if (year < 100) year += 2000;
      // Trend's numeric text dates are always month/day/year (the separator may
      // be /, - or .). Parse them explicitly instead of relying on the browser's
      // locale, so 7/2/2026 is 02 Jul and 8/7/2026 is 07 Aug everywhere.
      return isoDate(year, month, day);
    }

    match = text.match(/^(\d{1,2})[- ]([A-Za-z]{3,9})[- ,](\d{2,4})$/);
    if (match) {
      const months = {
        jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
        jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
      };
      let year = Number(match[3]);
      if (year < 100) year += 2000;
      return isoDate(year, months[match[2].slice(0, 3).toLowerCase()], match[1]);
    }

    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime())
      ? ""
      : isoDate(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate());
  }

  function toNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
    const text = clean(value).replace(/,/g, "").replace(/%$/, "");
    if (!text) return NaN;
    const number = Number(text);
    return Number.isFinite(number) ? number : NaN;
  }

  function toTimeOfDay(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return (
        value.getHours() * 3600000
        + value.getMinutes() * 60000
        + value.getSeconds() * 1000
        + value.getMilliseconds()
      );
    }

    const text = clean(value);
    if (!text) return NaN;
    const numeric = typeof value === "number" ? value : Number(text);
    if (Number.isFinite(numeric)) {
      const fraction = ((numeric % 1) + 1) % 1;
      return Math.min(86399999, Math.round(fraction * 86400000));
    }

    const match = text.match(/(?:^|[^0-9])(\d{1,2}):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,3}))?)?\s*([ap])?\.?m?\.?/i);
    if (!match) return NaN;

    let hour = Number(match[1]);
    const minute = Number(match[2]);
    const second = Number(match[3] || 0);
    const millisecond = Number(String(match[4] || "0").padEnd(3, "0"));
    const meridiem = String(match[5] || "").toLowerCase();
    if (meridiem) {
      if (hour < 1 || hour > 12) return NaN;
      hour = (hour % 12) + (meridiem === "p" ? 12 : 0);
    } else if (hour > 23) {
      return NaN;
    }
    return hour * 3600000 + minute * 60000 + second * 1000 + millisecond;
  }

  function visitTimeOrder(timeValue, dateValue) {
    const explicitTime = toTimeOfDay(timeValue);
    if (Number.isFinite(explicitTime)) return explicitTime;
    const embeddedTime = toTimeOfDay(dateValue);
    return Number.isFinite(embeddedTime) ? embeddedTime : -1;
  }

  function findHeaderRow(grid) {
    for (let rowIndex = 0; rowIndex < Math.min(grid.length, 15); rowIndex += 1) {
      const keys = (grid[rowIndex] || []).map(headerKey);
      const at = {};
      for (const [key, aliases] of Object.entries(HEADERS)) {
        at[key] = keys.findIndex((header) => header && aliases.includes(header));
      }
      if (at.code >= 0 && at.date >= 0 && at.score >= 0) return { row: rowIndex, at };
    }
    return null;
  }

  function fileLeafName(value) {
    const parts = clean(value).replace(/\\/g, "/").split("/");
    return parts[parts.length - 1] || "";
  }

  function pickTrendFile(files) {
    return (files || []).find((file) => {
      const name = fileLeafName(file?.name);
      const stem = name.replace(EXCEL_EXTENSION, "").trim().toLowerCase();
      const isExcel = EXCEL_EXTENSION.test(name)
        || /spreadsheetml|ms-excel/i.test(String(file?.mimeType || ""));
      return stem === "trend" && isExcel;
    }) || null;
  }

  async function toArrayBuffer(input) {
    if (!input) throw new Error("Nothing to read.");
    if (input instanceof ArrayBuffer) return input;
    if (ArrayBuffer.isView(input)) {
      return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    }
    if (typeof input.arrayBuffer === "function") return await input.arrayBuffer();
    throw new Error("Unsupported Trend workbook source.");
  }

  function parseWorkbook(buffer) {
    if (!global.XLSX) throw new Error("Spreadsheet library is not loaded.");
    if (!(buffer instanceof ArrayBuffer) && !ArrayBuffer.isView(buffer)) {
      throw new Error("Trend workbook bytes were not supplied.");
    }
    const bytes = ArrayBuffer.isView(buffer) ? buffer : new Uint8Array(buffer);
    const workbook = global.XLSX.read(bytes, {
      type: "array",
      cellDates: false,
      cellStyles: false,
      cellHTML: false,
      cellText: false,
      cellFormula: false,
      cellNF: false,
    });
    const date1904 = Boolean(workbook?.Workbook?.WBProps?.date1904);

    for (const sheetName of workbook.SheetNames || []) {
      const grid = global.XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
        header: 1,
        defval: "",
        blankrows: false,
        raw: true,
      });
      const found = findHeaderRow(grid);
      if (!found) continue;

      const outlets = new Map();
      let sourceRow = 0;
      for (const row of grid.slice(found.row + 1)) {
        sourceRow += 1;
        const code = clean(row[found.at.code]).toUpperCase();
        const dateValue = row[found.at.date];
        const date = toIsoDate(dateValue, date1904);
        const score = toNumber(row[found.at.score]);
        if (!code || !date || !Number.isFinite(score)) continue;

        const parsedMax = found.at.max >= 0 ? toNumber(row[found.at.max]) : NaN;
        const entry = outlets.get(code) || {
          name: found.at.name >= 0 ? clean(row[found.at.name]) : "",
          visits: [],
        };
        if (!entry.name && found.at.name >= 0) entry.name = clean(row[found.at.name]);
        entry.visits.push({
          date,
          score,
          max: Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 0,
          _time: visitTimeOrder(found.at.time >= 0 ? row[found.at.time] : "", dateValue),
          _row: sourceRow,
        });
        outlets.set(code, entry);
      }

      outlets.forEach((entry) => {
        const latestByDate = new Map();
        for (const visit of entry.visits) {
          const current = latestByDate.get(visit.date);
          if (
            !current
            || visit._time > current._time
            || (visit._time === current._time && visit._row > current._row)
          ) {
            latestByDate.set(visit.date, visit);
          }
        }
        entry.visits = [...latestByDate.values()]
          .sort((a, b) => a.date.localeCompare(b.date))
          .slice(-LAST_N)
          .map(({ _time, _row, ...visit }) => visit);
      });

      if (outlets.size) {
        const visits = [...outlets.values()].flatMap((entry) => entry.visits);
        const statedMax = Math.max(0, ...visits.map((visit) => Number(visit.max) || 0));
        const observedMax = Math.max(0, ...visits.map((visit) => Number(visit.score) || 0));
        const maxScore = statedMax || (observedMax > 0 && observedMax <= 1 ? 1 : observedMax);
        return {
          outlets,
          sheetName,
          maxScore,
          maxFromColumn: Boolean(statedMax),
        };
      }
    }

    throw new Error("No sheet with Outlet Code, Date and Score columns was found in Trend.");
  }

  function toPayload(parsed, fileName, sourceSignature = "") {
    if (!parsed?.outlets?.size) return null;
    return {
      fileName: fileName || parsed.fileName || "Trend workbook",
      sheet: parsed.sheetName || parsed.sheet || "",
      maxScore: Number(parsed.maxScore) || 0,
      maxFromColumn: Boolean(parsed.maxFromColumn),
      sourceSignature: clean(sourceSignature || parsed.sourceSignature),
      outlets: Object.fromEntries([...parsed.outlets].map(([code, entry]) => [
        code,
        { name: entry.name || "", visits: entry.visits || [] },
      ])),
    };
  }

  global.TrendSource = Object.freeze({
    LAST_N,
    FILE_NAME_MATCH,
    pickTrendFile,
    parseWorkbook,
    toPayload,
    toArrayBuffer,

    async fromDrive(drive, listedFiles = null) {
      if (!drive?.listFolderFiles || !drive?.downloadFile) return null;
      const files = listedFiles || await drive.listFolderFiles();
      const meta = pickTrendFile(files);
      if (!meta) return null;
      const downloaded = await drive.downloadFile(meta);
      const parsed = parseWorkbook(await toArrayBuffer(downloaded));
      const sourceSignature = typeof drive.remoteSignature === "function"
        ? drive.remoteSignature(meta)
        : [meta.id || "", meta.name || "", meta.size || "", meta.modifiedTime || ""].join("|");
      return { ...parsed, fileName: meta.name, sourceSignature, sourceMeta: meta };
    },

    async fromFile(file) {
      const parsed = parseWorkbook(await toArrayBuffer(file));
      const sourceSignature = [file.name || "", file.size || "", file.lastModified || ""].join("|");
      return { ...parsed, fileName: file.name, sourceSignature };
    },
  });
})(typeof window !== "undefined" ? window : globalThis);
