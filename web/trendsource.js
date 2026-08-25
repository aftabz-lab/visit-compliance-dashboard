/* ═══════════════════════════════════════════════════════════════════════════
   trend-source.js — reads the workbook named "Trend" and nothing else.

   Deliberately isolated: this module never writes to the dashboard's state and
   nothing in the visit-compliance or audit calculations reads from it. It is
   loaded only by index.html (the visit compliance dashboard), not by audit.html,
   and the file it reads is skipped by every other reader because they match on
   their own sheet and header signatures, which the Trend workbook does not have.

   Expected columns (matched case-insensitively, any order, extra columns ignored;
   spaces, underscores and punctuation inside the header text are ignored too):
     Outlet Code   — or Site Code / Store Code / Code / Outlet
     Date          — the visit date
     Score         — total visit score for that day (or Total / Total Score)
   Optional:
     Outlet Name
     Max           — or Max Score / Out Of / Total Marks / Full Marks
   ═══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  const FILE_NAME_MATCH = /(^|[^a-z])trends?([^a-z]|$)/i;   // the name never changes
  const LAST_N = 6;

  // Header aliases are compared after stripping everything that is not a letter
  // or a digit, so "Outlet Code", "outlet_code" and "OUTLET-CODE" all match.
  const HEADERS = {
    code: ["outletcode", "sitecode", "storecode", "outletid", "siteid", "outlet", "code"],
    name: ["outletname", "storename", "sitename", "name"],
    date: ["date", "visitdate", "auditdate", "responsedate", "visiteddate"],
    score: ["score", "totalscore", "visitscore", "auditscore", "obtainedscore",
            "achievedscore", "scoreobtained", "total"],
    max: ["max", "maxscore", "maximumscore", "outof", "totalmarks", "fullmarks",
          "totalpossible", "available"],
  };

  const clean = (v) => String(v ?? "").trim();
  const headerKey = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

  function findHeaderRow(grid) {
    for (let r = 0; r < Math.min(grid.length, 12); r += 1) {
      const keys = (grid[r] || []).map(headerKey);
      const at = {};
      for (const [key, names] of Object.entries(HEADERS)) {
        at[key] = keys.findIndex((h) => h && names.includes(h));
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

  /** Accepts an ArrayBuffer, a typed array, or a Blob/File and yields the bytes. */
  async function toArrayBuffer(input) {
    if (!input) throw new Error("Nothing to read.");
    if (input instanceof ArrayBuffer) return input;
    if (ArrayBuffer.isView(input)) return input.buffer;
    if (typeof input.arrayBuffer === "function") return await input.arrayBuffer();
    throw new Error("Unsupported Trend workbook source.");
  }

  /** Parses an ArrayBuffer into { outlets: Map(code -> {name, visits:[{date,score,max}]}) }. */
  function parseWorkbook(buffer) {
    if (!global.XLSX) throw new Error("Spreadsheet library is not loaded.");
    const bytes = ArrayBuffer.isView(buffer) ? buffer : new Uint8Array(buffer);
    // Everything that is not a cell value is switched off. A Trend workbook can
    // be large, and formulas, number formats and workbook metadata are what make
    // a large one exhaust the tab.
    const wb = global.XLSX.read(bytes, {
      type: "array", cellDates: true, cellStyles: false, cellFormula: false,
      cellHTML: false, cellNF: false, bookDeps: false, bookProps: false,
      bookVBA: false,
    });
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
        const rowMax = at.max >= 0 ? Number(line[at.max]) : 0;
        const entry = outlets.get(code) || { name: at.name >= 0 ? clean(line[at.name]) : "", visits: [] };
        if (!entry.name && at.name >= 0) entry.name = clean(line[at.name]);
        entry.visits.push({ date, score, max: Number.isFinite(rowMax) ? rowMax : 0 });
        outlets.set(code, entry);
      }
      // Keep the most recent visits only, oldest-to-newest for the chart.
      outlets.forEach((entry) => {
        entry.visits.sort((a, b) => a.date.localeCompare(b.date));
        entry.visits = entry.visits.slice(-LAST_N);
      });
      if (outlets.size) {
        // Percentages need a denominator. An explicit max column wins; otherwise
        // the highest score anywhere in the file is used — the same rule the
        // GitHub build uses, so a Drive read and a published build agree.
        // Reduced rather than spread: a workbook with very many outlet codes
        // would blow the call stack if every visit became a Math.max argument.
        let statedMax = 0;
        let topScore = 0;
        outlets.forEach((entry) => entry.visits.forEach((v) => {
          const max = Number(v.max) || 0;
          const score = Number(v.score) || 0;
          if (max > statedMax) statedMax = max;
          if (score > topScore) topScore = score;
        }));
        const maxScore = statedMax || topScore;
        return { outlets, sheetName, maxScore, maxFromColumn: Boolean(statedMax) };
      }
    }
    throw new Error("No sheet with Outlet Code, Date and Score columns.");
  }

  /** Parses, and blames the file size when a large workbook is what broke it. */
  function parseSized(buffer, fileName, size) {
    try {
      return parseWorkbook(buffer);
    } catch (error) {
      const mb = Math.round((Number(size) || 0) / 1048576);
      const reason = error?.message || String(error);
      if (mb >= 25) {
        throw new Error(
          `${fileName || "the Trend workbook"} is ${mb} MB and could not be read in the browser (${reason}). `
          + "Keep only the Outlet Code, Date and Score columns on one sheet and save it again.",
        );
      }
      throw error;
    }
  }

  /** Picks the Trend workbook out of a list of {name} file entries. */
  function pickTrendFile(files) {
    const matches = (files || []).filter(
      (f) => FILE_NAME_MATCH.test(String(f.name || "")) && /\.xlsx$|\.xlsm$/i.test(String(f.name || "")),
    );
    if (!matches.length) return null;
    // A file actually called "Trend.xlsx" always wins over a longer name.
    const exact = matches.find((f) => headerKey(String(f.name || "").replace(/\.[^.]+$/, "")) === "trend");
    return exact || matches[0];
  }

  /** Plain-JSON shape published with the dashboard payload (same as build.py). */
  function toPayload(parsed, fileName) {
    if (!parsed?.outlets?.size) return null;
    return {
      fileName: fileName || parsed.fileName || "Trend workbook",
      sheet: parsed.sheetName || "",
      maxScore: Number(parsed.maxScore) || 0,
      maxFromColumn: Boolean(parsed.maxFromColumn),
      outlets: Object.fromEntries([...parsed.outlets].map(([code, entry]) => [
        code, { name: entry.name || "", visits: entry.visits || [] },
      ])),
    };
  }

  global.TrendSource = {
    LAST_N,
    FILE_NAME_MATCH,
    pickTrendFile,
    parseWorkbook,
    toPayload,
    toArrayBuffer,

    /** Reads the Trend workbook from the connected Google Drive folder, if present. */
    async fromDrive(drive) {
      if (!drive?.listFolderFiles || !drive?.downloadFile) return null;
      const files = await drive.listFolderFiles();
      const meta = pickTrendFile(files);
      if (!meta) return null;
      // downloadFile hands back a File, so its bytes have to be read out before
      // the spreadsheet library sees them. Passing the File straight through was
      // silently producing no chart at all.
      const downloaded = await drive.downloadFile(meta);
      const parsed = parseSized(await toArrayBuffer(downloaded), meta.name, Number(meta.size) || downloaded?.size);
      return { ...parsed, fileName: meta.name };
    },

    /** Reads it from a File the user picked directly. */
    async fromFile(file) {
      const parsed = parseSized(await toArrayBuffer(file), file.name, file.size);
      return { ...parsed, fileName: file.name };
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
