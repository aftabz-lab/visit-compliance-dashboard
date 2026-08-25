/* ═══════════════════════════════════════════════════════════════════════════
   trend-source.js — reads the workbook named "Trend" and nothing else.

   Deliberately isolated: this module never writes to the dashboard's state and
   nothing in the visit-compliance or audit calculations reads from it. It is
   loaded only by index.html (the visit compliance dashboard), not by audit.html,
   and the file it reads is skipped by every other reader because they match on
   their own sheet and header signatures, which the Trend workbook does not have.

   Expected columns (matched case-insensitively, any order, extra columns ignored):
     Outlet Code   — or Site Code / Code / Outlet
     Date          — the visit date
     Score         — total visit score for that day (or Total / Total Score)
   Optional:
     Outlet Name
   ═══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  const FILE_NAME_MATCH = /(^|[^a-z])trend([^a-z]|$)/i;   // the name never changes
  const LAST_N = 6;

  const HEADERS = {
    code: ["outlet code", "site code", "outlet", "code"],
    name: ["outlet name", "name"],
    date: ["date", "visit date"],
    score: ["score", "total score", "total", "visit score"],
  };

  const clean = (v) => String(v ?? "").trim();

  function findHeaderRow(grid) {
    for (let r = 0; r < Math.min(grid.length, 12); r += 1) {
      const lower = (grid[r] || []).map((c) => clean(c).toLowerCase());
      const at = {};
      for (const [key, names] of Object.entries(HEADERS)) {
        at[key] = lower.findIndex((h) => names.includes(h));
      }
      if (at.code >= 0 && at.date >= 0 && at.score >= 0) return { row: r, at };
    }
    return null;
  }

  function toIsoDate(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value.toISOString().slice(0, 10);
    }
    const text = clean(value);
    if (!text) return "";
    // Excel serial date
    const serial = Number(text);
    if (Number.isFinite(serial) && serial > 20000 && serial < 60000) {
      const ms = Math.round((serial - 25569) * 86400 * 1000);
      return new Date(ms).toISOString().slice(0, 10);
    }
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
  }

  /** Parses an ArrayBuffer into { outlets: Map(code -> {name, visits:[{date,score}]}) }. */
  function parseWorkbook(buffer) {
    if (!global.XLSX) throw new Error("Spreadsheet library is not loaded.");
    const wb = global.XLSX.read(buffer, { type: "array", cellDates: true, cellStyles: false });
    for (const sheetName of wb.SheetNames) {
      const grid = global.XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
        header: 1, defval: "", blankrows: false,
      });
      const found = findHeaderRow(grid);
      if (!found) continue;
      const { row, at } = found;
      const outlets = new Map();
      for (const line of grid.slice(row + 1)) {
        const code = clean(line[at.code]).toUpperCase();
        if (!code) continue;
        const date = toIsoDate(line[at.date]);
        const score = Number(line[at.score]);
        if (!date || !Number.isFinite(score)) continue;
        const entry = outlets.get(code) || { name: at.name >= 0 ? clean(line[at.name]) : "", visits: [] };
        if (!entry.name && at.name >= 0) entry.name = clean(line[at.name]);
        entry.visits.push({ date, score });
        outlets.set(code, entry);
      }
      // Keep the most recent visits only, oldest-to-newest for the chart.
      outlets.forEach((entry) => {
        entry.visits.sort((a, b) => a.date.localeCompare(b.date));
        entry.visits = entry.visits.slice(-LAST_N);
      });
      if (outlets.size) return { outlets, sheetName };
    }
    throw new Error("No sheet with Outlet Code, Date and Score columns.");
  }

  /** Picks the Trend workbook out of a list of {name} file entries. */
  function pickTrendFile(files) {
    return (files || []).find(
      (f) => FILE_NAME_MATCH.test(String(f.name || "")) && /\.xlsx$|\.xlsm$/i.test(String(f.name || "")),
    ) || null;
  }

  global.TrendSource = {
    LAST_N,
    FILE_NAME_MATCH,
    pickTrendFile,
    parseWorkbook,

    /** Reads the Trend workbook from the connected Google Drive folder, if present. */
    async fromDrive(drive) {
      if (!drive?.listFolderFiles || !drive?.downloadFile) return null;
      const files = await drive.listFolderFiles();
      const meta = pickTrendFile(files);
      if (!meta) return null;
      const buffer = await drive.downloadFile(meta);
      const parsed = parseWorkbook(buffer);
      return { ...parsed, fileName: meta.name };
    },

    /** Reads it from a File the user picked directly. */
    async fromFile(file) {
      const parsed = parseWorkbook(await file.arrayBuffer());
      return { ...parsed, fileName: file.name };
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
