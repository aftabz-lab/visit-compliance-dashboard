/*
 * Shared outlet-attendance reader for Visit Compliance and Audit Quality.
 *
 * Attendance exports are identified by their headers, not by a fixed month or
 * filename. Column H ("Outlet Time Range") may contain several outlet visits:
 *   F630 (07:21 PM - 07:21 PM); F468 (08:36 PM - 08:36 PM)
 *
 * The response workbook supplies the audit date, outlet and survey time. Those
 * values are used together to select the correct outlet range. Employee-code
 * votes across the month disambiguate cases where Zonal and RHO visited the
 * same outlet on the same day and the attendance export has no employee name.
 */
(function installAttendanceSource(global) {
  "use strict";

  const cleanText = (value) => String(value == null ? "" : value)
    .normalize("NFKC").replace(/\s+/g, " ").trim();
  const siteKey = (value) => cleanText(value).toUpperCase();
  const nameKey = (value) => cleanText(value).toLocaleLowerCase()
    .replace(/[.,'’`"()\-_/\\]+/g, " ").replace(/\s+/g, " ").trim();
  const pad2 = (value) => String(value).padStart(2, "0");

  function isoDate(year, month, day) {
    const y = Number(year), m = Number(month), d = Number(day);
    if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)
      || m < 1 || m > 12 || d < 1 || d > 31) return null;
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
    return `${y}-${pad2(m)}-${pad2(d)}`;
  }

  function parseDate(value) {
    if (value == null || value === "") return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return isoDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      const probe = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
      return Number.isNaN(probe.getTime()) ? null
        : isoDate(probe.getUTCFullYear(), probe.getUTCMonth() + 1, probe.getUTCDate());
    }
    const text = cleanText(value);
    let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) return isoDate(match[1], match[2], match[3]);
    match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (match) {
      let year = Number(match[3]);
      if (year < 100) year += 2000;
      const first = Number(match[1]), second = Number(match[2]);
      if (first > 12 && second <= 12) return isoDate(year, second, first);
      return isoDate(year, first, second);
    }
    return null;
  }

  function parseClockMinutes(value) {
    if (value == null || value === "") return null;
    if (typeof value === "number" && Number.isFinite(value)) {
      const fraction = ((value % 1) + 1) % 1;
      return Math.round(fraction * 86400) / 60;
    }
    const text = cleanText(value).replace(/\./g, "");
    const twelveHour = text.match(/(?:^|\s)(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP])M(?:$|\s)/i);
    if (twelveHour) {
      let hour = Number(twelveHour[1]) % 12;
      if (twelveHour[4].toUpperCase() === "P") hour += 12;
      return hour * 60 + Number(twelveHour[2]) + Number(twelveHour[3] || 0) / 60;
    }
    const twentyFourHour = text.match(/(?:^|\s)([01]?\d|2[0-3]):(\d{2})(?::(\d{2}))?(?:$|\s)/);
    if (twentyFourHour) {
      return Number(twentyFourHour[1]) * 60 + Number(twentyFourHour[2]) + Number(twentyFourHour[3] || 0) / 60;
    }
    return null;
  }

  function formatClock(value) {
    const parsed = parseClockMinutes(value);
    if (parsed == null) return cleanText(value);
    const totalMinutes = ((Math.round(parsed) % 1440) + 1440) % 1440;
    const hour24 = Math.floor(totalMinutes / 60);
    const minute = totalMinutes % 60;
    const period = hour24 >= 12 ? "PM" : "AM";
    const hour12 = hour24 % 12 || 12;
    return `${pad2(hour12)}:${pad2(minute)} ${period}`;
  }

  function parseCsv(text) {
    const rows = [];
    let row = [], field = "", quoted = false;
    const source = String(text || "").replace(/^\uFEFF/, "");
    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      if (quoted) {
        if (char === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
        else if (char === '"') quoted = false;
        else field += char;
      } else if (char === '"') quoted = true;
      else if (char === ",") { row.push(field); field = ""; }
      else if (char === "\n") {
        row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = "";
      } else field += char;
    }
    if (field || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
    return rows;
  }

  function headerIndex(row) {
    const map = new Map();
    (row || []).forEach((value, index) => {
      const key = cleanText(value).replace(/^\uFEFF/, "").toLocaleLowerCase();
      if (key) map.set(key, index);
    });
    return map;
  }

  function validEmployeeName(value) {
    const text = cleanText(value);
    return /^(?:n\/?a|na|none|null|-)$/i.test(text) ? "" : text;
  }

  function parseOutletRanges(value, context) {
    const entries = [];
    String(value || "").split(";").forEach((rawRange) => {
      const match = rawRange.match(/^\s*([A-Za-z0-9_-]+)\s*\(\s*([^)]+?)\s*\)\s*$/);
      if (!match) return;
      const times = match[2].match(/^\s*(.+?)\s+[-–—]\s+(.+?)\s*$/);
      if (!times) return;
      const inTime = formatClock(times[1]);
      const outTime = formatClock(times[2]);
      if (!inTime || !outTime) return;
      entries.push({
        date: context.date,
        siteCode: siteKey(match[1]),
        employeeCode: cleanText(context.employeeCode),
        employeeName: validEmployeeName(context.employeeName),
        inTime,
        outTime,
        inMinutes: parseClockMinutes(times[1]),
        outMinutes: parseClockMinutes(times[2]),
        label: `${inTime} - ${outTime}`,
        sourceFile: context.sourceFile || "",
      });
    });
    return entries;
  }

  function parseAttendanceGrid(grid, sourceFile = "") {
    const headerRow = (grid || []).findIndex((row) => {
      const map = headerIndex(row);
      return map.has("date") && map.has("employee code") && map.has("outlet time range");
    });
    if (headerRow < 0) throw new Error('Attendance file is missing Date, Employee Code, or Outlet Time Range.');
    const headers = headerIndex(grid[headerRow]);
    const at = (name) => headers.get(name);
    const entries = [];
    let sourceRows = 0;
    for (const row of grid.slice(headerRow + 1)) {
      const date = parseDate(row[at("date")]);
      const range = row[at("outlet time range")];
      if (!date || !cleanText(range)) continue;
      sourceRows += 1;
      entries.push(...parseOutletRanges(range, {
        date,
        employeeCode: row[at("employee code")],
        employeeName: headers.has("employee name") ? row[at("employee name")] : "",
        sourceFile,
      }));
    }
    return { entries, sourceRows };
  }

  async function readAttendanceFile(file) {
    let grid;
    if (/\.csv$/i.test(file?.name || "")) grid = parseCsv(await file.text());
    else {
      const XLSX = global.XLSX;
      if (!XLSX) throw new Error("The Excel reader did not load.");
      const book = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false, cellStyles: false });
      let parsed = null;
      for (const sheetName of book.SheetNames) {
        const candidate = XLSX.utils.sheet_to_json(book.Sheets[sheetName], { header: 1, defval: "", blankrows: false, raw: true });
        try { parsed = parseAttendanceGrid(candidate, file.name); break; } catch { /* try another sheet */ }
      }
      if (!parsed) throw new Error("No attendance sheet with Outlet Time Range was found.");
      return { ...parsed, fileName: file.name };
    }
    return { ...parseAttendanceGrid(grid, file.name), fileName: file.name };
  }

  async function readAttendanceFiles(files) {
    const entries = [], fileNames = [], errors = [];
    let sourceRows = 0;
    for (const file of files || []) {
      try {
        const parsed = await readAttendanceFile(file);
        entries.push(...parsed.entries);
        sourceRows += parsed.sourceRows;
        fileNames.push(parsed.fileName);
      } catch (error) {
        errors.push(`${file?.name || "Attendance file"}: ${error?.message || "could not read"}`);
      }
    }
    const unique = new Map();
    entries.forEach((entry) => {
      // Files are supplied newest first. A newer overlapping export replaces
      // the older range for the same employee/outlet/day.
      const key = [entry.date, entry.siteCode, entry.employeeCode].join("|");
      if (!unique.has(key)) unique.set(key, entry);
    });
    return { entries: [...unique.values()], fileNames, sourceRows, errors };
  }

  function intervalDistance(time, start, end) {
    if (![time, start, end].every(Number.isFinite)) return Number.POSITIVE_INFINITY;
    const t = ((time % 1440) + 1440) % 1440;
    const s = ((start % 1440) + 1440) % 1440;
    const e = ((end % 1440) + 1440) % 1440;
    if (s <= e) return t >= s && t <= e ? 0 : Math.min(Math.abs(t - s), Math.abs(t - e));
    return t >= s || t <= e ? 0 : Math.min(Math.abs(t - s), Math.abs(t - e));
  }

  function pairKey(response) {
    return `${parseDate(response.responseDate || response.date) || ""}|${siteKey(response.siteCode)}`;
  }

  function candidateNameMatches(response, candidate) {
    const employee = nameKey(candidate.employeeName);
    return Boolean(employee && employee === nameKey(response.officer));
  }

  function rankedCandidates(response, candidates, preferredEmployeeCode = "") {
    const responseTime = Number.isFinite(response.responseTimeMinutes)
      ? response.responseTimeMinutes : parseClockMinutes(response.responseTime || response.time);
    return [...candidates].map((candidate) => ({
      candidate,
      preferred: preferredEmployeeCode && candidate.employeeCode === preferredEmployeeCode ? 0 : 1,
      name: candidateNameMatches(response, candidate) ? 0 : 1,
      distance: intervalDistance(responseTime, candidate.inMinutes, candidate.outMinutes),
    })).sort((a, b) => a.preferred - b.preferred || a.name - b.name || a.distance - b.distance
      || String(a.candidate.employeeCode).localeCompare(String(b.candidate.employeeCode)));
  }

  function confidentFirstPass(response, candidates) {
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0];
    const nameMatches = candidates.filter((candidate) => candidateNameMatches(response, candidate));
    if (nameMatches.length === 1) return nameMatches[0];
    const ranked = rankedCandidates(response, candidates);
    if (ranked.length === 1 || ranked[0].distance < ranked[1].distance) return ranked[0].candidate;
    return null;
  }

  function finalCandidate(response, candidates, preferredEmployeeCode) {
    if (!candidates.length) return null;
    const nameMatches = candidates.filter((candidate) => candidateNameMatches(response, candidate));
    if (nameMatches.length === 1) return nameMatches[0];
    const codeMatches = preferredEmployeeCode
      ? candidates.filter((candidate) => candidate.employeeCode === preferredEmployeeCode) : [];
    if (codeMatches.length === 1) return codeMatches[0];
    if (candidates.length === 1) return candidates[0];
    const ranked = rankedCandidates(response, candidates, preferredEmployeeCode);
    if (ranked.length === 1) return ranked[0].candidate;
    const first = ranked[0], second = ranked[1];
    const sameRank = first.preferred === second.preferred && first.name === second.name && first.distance === second.distance;
    if (!sameRank) return first.candidate;
    return first.candidate.employeeCode === second.candidate.employeeCode ? first.candidate : null;
  }

  function matchResponses(responses, attendanceEntries) {
    const byPair = new Map();
    (attendanceEntries || []).forEach((entry) => {
      const key = `${entry.date}|${siteKey(entry.siteCode)}`;
      if (!byPair.has(key)) byPair.set(key, []);
      byPair.get(key).push(entry);
    });

    const votes = new Map();
    const addVote = (officer, employeeCode) => {
      const key = nameKey(officer);
      if (!key || !employeeCode) return;
      if (!votes.has(key)) votes.set(key, new Map());
      const counts = votes.get(key);
      counts.set(employeeCode, (counts.get(employeeCode) || 0) + 1);
    };
    (responses || []).forEach((response) => {
      const selected = confidentFirstPass(response, byPair.get(pairKey(response)) || []);
      if (selected) addVote(response.officer, selected.employeeCode);
    });

    const officerCodes = new Map();
    votes.forEach((counts, officer) => {
      const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
      if (ranked.length && (!ranked[1] || ranked[0][1] > ranked[1][1])) officerCodes.set(officer, ranked[0][0]);
    });

    let matchedCount = 0, ambiguousCount = 0;
    const matched = (responses || []).map((response) => {
      const candidates = byPair.get(pairKey(response)) || [];
      const selected = finalCandidate(response, candidates, officerCodes.get(nameKey(response.officer)) || "");
      if (!selected) {
        if (candidates.length) ambiguousCount += 1;
        return { ...response, outletTimeRange: "", attendanceEmployeeCode: "" };
      }
      matchedCount += 1;
      return { ...response, outletTimeRange: selected.label, attendanceEmployeeCode: selected.employeeCode };
    });
    return {
      responses: matched,
      matchedCount,
      missingCount: matched.length - matchedCount,
      ambiguousCount,
      inferredOfficerCodes: officerCodes.size,
    };
  }

  global.ShwapnoAttendance = Object.freeze({
    cleanText,
    normalizeName: nameKey,
    siteKey,
    parseDate,
    parseClockMinutes,
    formatClock,
    parseCsv,
    parseAttendanceGrid,
    readAttendanceFile,
    readAttendanceFiles,
    matchResponses,
  });
})(typeof window !== "undefined" ? window : globalThis);
