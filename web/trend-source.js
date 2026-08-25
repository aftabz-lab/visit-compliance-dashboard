/* Trend source fix: reads only Trend.xlsx / Trend.xlsm from the Trend analysis source. */
(function (global) {
  "use strict";

  const FILE_NAME_MATCH = /(^|[^a-z])trend([^a-z]|$)/i;
  const LAST_N = 6;

  const HEADERS = {
    code: ["outlet code", "site code", "outlet", "code"],
    name: ["outlet name", "name"],
    date: ["date", "visit date"],
    score: ["score", "total score", "total", "visit score"],
  };

  const clean = (v) => String(v ?? "").trim();

  function findHeaderRow(grid) {
    for (let r = 0; r < Math.min(grid.length, 12); r++) {
      const lower = (grid[r] || []).map(c => clean(c).toLowerCase());
      const at = {};
      for (const [key, names] of Object.entries(HEADERS)) {
        at[key] = lower.findIndex(h => names.includes(h));
      }
      if (at.code >= 0 && at.date >= 0 && at.score >= 0) return {row:r, at};
    }
    return null;
  }

  function toIsoDate(value) {
    if (value instanceof Date && !isNaN(value)) return value.toISOString().slice(0,10);
    const t = clean(value);
    if (!t) return "";
    const parts = t.split(/[\/\-.]/);
    if (parts.length === 3 && parts[0].length <= 2 && parts[1].length <= 2) {
      const d = parts[0].padStart(2,"0");
      const m = parts[1].padStart(2,"0");
      const y = parts[2].length === 2 ? "20" + parts[2] : parts[2];
      return `${y}-${m}-${d}`;
    }
    const parsed = new Date(t);
    return isNaN(parsed) ? "" : parsed.toISOString().slice(0,10);
  }

  function parseWorkbook(buffer) {
    if (!global.XLSX) throw new Error("Spreadsheet library is not loaded.");
    const wb = global.XLSX.read(buffer,{type:"array",cellDates:true});
    for (const sheetName of wb.SheetNames) {
      const grid = global.XLSX.utils.sheet_to_json(wb.Sheets[sheetName],{header:1,defval:""});
      const found = findHeaderRow(grid);
      if (!found) continue;
      const outlets = new Map();
      for (const row of grid.slice(found.row+1)) {
        const code = clean(row[found.at.code]).toUpperCase();
        const date = toIsoDate(row[found.at.date]);
        const score = Number(row[found.at.score]);
        if (!code || !date || !Number.isFinite(score)) continue;
        const item = outlets.get(code) || {name:"",visits:[]};
        if (found.at.name >= 0) item.name = item.name || clean(row[found.at.name]);
        item.visits.push({date,score});
        outlets.set(code,item);
      }
      outlets.forEach(v => {v.visits.sort((a,b)=>a.date.localeCompare(b.date));v.visits=v.visits.slice(-LAST_N);});
      if (outlets.size) return {outlets,sheetName};
    }
    throw new Error("No Trend columns found.");
  }

  function pickTrendFile(files) {
    return (files||[]).find(f => FILE_NAME_MATCH.test(String(f.name||"")) && /\.(xlsx|xlsm)$/i.test(String(f.name||""))) || null;
  }

  global.TrendSource = {
    LAST_N,
    FILE_NAME_MATCH,
    pickTrendFile,
    parseWorkbook,
    async fromDrive(drive) {
      const files = await drive.listFolderFiles();
      const meta = pickTrendFile(files);
      if (!meta) return null;
      return {...parseWorkbook(await drive.downloadFile(meta)), fileName: meta.name};
    },
    async fromFile(file) {
      return {...parseWorkbook(await file.arrayBuffer()), fileName:file.name};
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
