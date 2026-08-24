(function (global) {
  "use strict";

  const zip = global.fflate;
  const MODE = "final-detail-v2";
  const CACHE_VERSION = 6;
  const CRITERIA = [["Core SKU", "CORE"], ["KVI SKU", "KVI"], ["Promo SKU", "PROMO"], ["HGPHS SKU", "HGPHS"]];
  const FIRST_STOCK_COLUMN = columnNumber("G");
  const LAST_STOCK_COLUMN = columnNumber("AKD");
  const FIRST_OUTPUT_COLUMN = columnNumber("AKF");
  const LAST_OUTPUT_COLUMN = columnNumber("BVC");
  const META_FIRST_COLUMN = columnNumber("B");
  const META_LAST_COLUMN = columnNumber("F");
  const descriptorCache = new WeakMap();

  function normalText(value) { return String(value ?? "").trim(); }
  function normalKey(value) { return normalText(value).toUpperCase(); }

  function columnNumber(letters) {
    let number = 0;
    for (const char of String(letters || "").toUpperCase()) number = number * 26 + char.charCodeAt(0) - 64;
    return number;
  }

  function columnName(number) {
    let value = Number(number) || 0;
    let name = "";
    while (value > 0) {
      value -= 1;
      name = String.fromCharCode(65 + (value % 26)) + name;
      value = Math.floor(value / 26);
    }
    return name;
  }

  function decodeXml(value) {
    return String(value ?? "")
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  }

  function xmlAttribute(tag, name) {
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = String(tag).match(new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
    return decodeXml(match?.[1] ?? match?.[2] ?? "");
  }

  function concatChunks(chunks) {
    const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
    return merged;
  }

  function normalizeRelationshipTarget(target) {
    let path = normalText(target).replace(/\\/g, "/");
    if (path.startsWith("/")) return path.slice(1);
    if (!path.startsWith("xl/")) path = `xl/${path}`;
    const parts = [];
    for (const part of path.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return parts.join("/");
  }

  function workbookDescriptor(bytes) {
    if (!zip?.unzipSync || !zip?.strFromU8) throw new Error("The Final workbook reader did not load.");
    const required = new Set(["xl/workbook.xml", "xl/_rels/workbook.xml.rels"]);
    const files = zip.unzipSync(bytes, { filter: entry => required.has(entry.name) });
    const workbookBytes = files["xl/workbook.xml"];
    const relationshipBytes = files["xl/_rels/workbook.xml.rels"];
    if (!workbookBytes || !relationshipBytes) return null;

    const workbookXml = zip.strFromU8(workbookBytes);
    const relationshipXml = zip.strFromU8(relationshipBytes);
    const relationships = new Map();
    for (const tag of relationshipXml.match(/<Relationship\b[^>]*\/?\s*>/gi) || []) {
      relationships.set(xmlAttribute(tag, "Id"), normalizeRelationshipTarget(xmlAttribute(tag, "Target")));
    }

    const sheets = new Map();
    for (const tag of workbookXml.match(/<sheet\b[^>]*\/?\s*>/gi) || []) {
      const name = normalText(xmlAttribute(tag, "name"));
      const relationshipId = xmlAttribute(tag, "r:id");
      const path = relationships.get(relationshipId);
      if (name && path) sheets.set(name.toLowerCase(), { name, path });
    }
    const detail = sheets.get("detail");
    const summary = sheets.get("summary");
    return detail && summary ? { detail, summary } : null;
  }

  async function inspect(file) {
    if (descriptorCache.has(file)) return descriptorCache.get(file);
    try {
      const descriptor = workbookDescriptor(new Uint8Array(await file.arrayBuffer()));
      descriptorCache.set(file, descriptor);
      return descriptor;
    } catch {
      descriptorCache.set(file, null);
      return null;
    }
  }

  function cellToken(attributes, body) {
    const type = xmlAttribute(attributes, "t") || "n";
    const valueMatch = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i);
    const formulaMatch = body.match(/<f\b[^>]*>([\s\S]*?)<\/f>/i);
    const inlineParts = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map(match => decodeXml(match[1]));
    return {
      type,
      raw: valueMatch ? decodeXml(valueMatch[1]) : inlineParts.join(""),
      formula: formulaMatch ? decodeXml(formulaMatch[1]) : "",
    };
  }

  function createWorksheetCollector() {
    const rows = new Map();
    const decoder = new TextDecoder();
    let carry = "";
    let maxRow = 0;

    function parseRow(rowXml) {
      const openTag = rowXml.match(/^<row\b[^>]*>/i)?.[0] || "";
      const rowNumber = Number(xmlAttribute(openTag, "r"));
      if (!rowNumber || rowNumber > 10000) return;
      maxRow = Math.max(maxRow, rowNumber);

      const isHeaderRow = rowNumber === 1 || rowNumber === 4 || rowNumber === 5;
      const isFormulaProofRow = rowNumber === 6;
      const maxColumn = isHeaderRow ? LAST_STOCK_COLUMN : isFormulaProofRow ? LAST_OUTPUT_COLUMN : META_LAST_COLUMN;
      const cells = new Map();
      const cellPattern = /<c\b([^>]*)>([\s\S]*?)<\/c>/gi;
      let match;
      while ((match = cellPattern.exec(rowXml))) {
        const reference = xmlAttribute(match[1], "r");
        const letters = reference.match(/^([A-Z]+)/i)?.[1] || "";
        const column = columnNumber(letters);
        if (!column) continue;
        if (column > maxColumn) break;
        const metaCell = column >= META_FIRST_COLUMN && column <= META_LAST_COLUMN;
        const stockHeaderCell = isHeaderRow && column >= FIRST_STOCK_COLUMN && column <= LAST_STOCK_COLUMN;
        const proofFormulaCell = isFormulaProofRow && column >= FIRST_OUTPUT_COLUMN && column <= LAST_OUTPUT_COLUMN;
        if (metaCell || stockHeaderCell || proofFormulaCell) cells.set(column, cellToken(match[1], match[2]));
      }
      if (cells.size) rows.set(rowNumber, cells);
    }

    function push(data, final) {
      carry += decoder.decode(data, { stream: !final });
      for (;;) {
        const start = carry.indexOf("<row");
        if (start < 0) {
          if (carry.length > 4096) carry = carry.slice(-4096);
          break;
        }
        if (start > 0) carry = carry.slice(start);
        const end = carry.indexOf("</row>");
        if (end < 0) break;
        parseRow(carry.slice(0, end + 6));
        carry = carry.slice(end + 6);
      }
    }

    return { rows, push, get maxRow() { return maxRow; } };
  }

  function parseSharedStrings(xml) {
    const values = [];
    for (const match of String(xml || "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)) {
      values.push([...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map(part => decodeXml(part[1])).join(""));
    }
    return values;
  }

  function tokenValue(token, sharedStrings) {
    if (!token) return "";
    if (token.type === "s") return sharedStrings[Number(token.raw)] ?? "";
    if (token.type === "inlineStr" || token.type === "str" || token.type === "e") return token.raw;
    if (token.type === "b") return token.raw === "1";
    const number = Number(token.raw);
    return token.raw !== "" && Number.isFinite(number) ? number : token.raw;
  }

  async function streamSelectedEntries(file, descriptor) {
    const wantedSheets = new Map([
      [descriptor.detail.path, createWorksheetCollector()],
      [descriptor.summary.path, createWorksheetCollector()],
    ]);
    const sharedChunks = [];
    let streamError = null;
    let foundSharedStrings = false;

    const unzipper = new zip.Unzip(entry => {
      const collector = wantedSheets.get(entry.name);
      const isSharedStrings = entry.name === "xl/sharedStrings.xml";
      if (!collector && !isSharedStrings) return;
      if (isSharedStrings) foundSharedStrings = true;
      entry.ondata = (error, data, final) => {
        if (error) { streamError = error; return; }
        try {
          if (collector) collector.push(data, final);
          else if (data?.length) sharedChunks.push(data.slice());
        } catch (parseError) { streamError = parseError; }
      };
      entry.start();
    });
    unzipper.register(zip.UnzipInflate);

    const reader = file.stream().getReader();
    for (;;) {
      const { value, done } = await reader.read();
      unzipper.push(value || new Uint8Array(0), done);
      if (streamError) throw streamError;
      if (done) break;
    }

    const sharedXml = foundSharedStrings ? zip.strFromU8(concatChunks(sharedChunks)) : "";
    return {
      detail: wantedSheets.get(descriptor.detail.path),
      summary: wantedSheets.get(descriptor.summary.path),
      sharedStrings: parseSharedStrings(sharedXml),
    };
  }

  function normalizedFormula(value) {
    return normalText(value).replace(/^=/, "").replace(/\s+/g, "").toUpperCase();
  }

  function validateFormulaBlock(detail) {
    const formulaRow = detail.rows.get(6);
    const outputWidth = LAST_OUTPUT_COLUMN - FIRST_OUTPUT_COLUMN + 1;
    const stockWidth = LAST_STOCK_COLUMN - FIRST_STOCK_COLUMN + 1;
    if (!formulaRow || outputWidth !== stockWidth) throw new Error("Final!Detail AKF:BVC does not match the G:AKD stock block.");
    let checked = 0;
    for (let outputColumn = FIRST_OUTPUT_COLUMN; outputColumn <= LAST_OUTPUT_COLUMN; outputColumn += 1) {
      const sourceColumn = FIRST_STOCK_COLUMN + outputColumn - FIRST_OUTPUT_COLUMN;
      const sourceName = columnName(sourceColumn);
      // The first two source columns (DK11/DK14) use their row-4 value (12).
      // Every remaining formula in the supplied Final file uses Summary!$F$6 (1).
      const thresholdReference = sourceColumn <= columnNumber("H") ? `${sourceName}$4` : "SUMMARY!$F$6";
      const expected = `IF(${sourceName}6>=${thresholdReference},1,0)`;
      const actual = normalizedFormula(formulaRow.get(outputColumn)?.formula);
      if (actual !== expected) {
        throw new Error(`Final!Detail ${columnName(outputColumn)}6 is not ${expected}.`);
      }
      checked += 1;
    }
    return checked;
  }

  async function read(file) {
    const descriptor = await inspect(file);
    if (!descriptor) throw new Error("Select the Final workbook containing Detail and Summary sheets.");
    const parsed = await streamSelectedEntries(file, descriptor);
    const detail = parsed.detail;
    const summary = parsed.summary;
    const shared = parsed.sharedStrings;
    if (!detail || !summary) throw new Error("Could not read Final!Detail and Final!Summary.");

    const headerCells = detail.rows.get(5) || new Map();
    let codeColumn = 0;
    let typeColumn = 0;
    for (let column = META_FIRST_COLUMN; column <= META_LAST_COLUMN; column += 1) {
      const header = normalText(tokenValue(headerCells.get(column), shared)).toLowerCase();
      if (header === "code") codeColumn = column;
      if (header === "type") typeColumn = column;
    }
    if (!codeColumn || !typeColumn) throw new Error("No Code/Type headers were found on Final!Detail row 5.");

    const summaryThreshold = Number(tokenValue(summary.rows.get(6)?.get(columnNumber("F")), shared));
    const defaultThreshold = Number.isFinite(summaryThreshold) && summaryThreshold > 0 ? summaryThreshold : 1;
    const thresholds = new Map();
    const headerRow1 = detail.rows.get(1) || new Map();
    const headerRow4 = detail.rows.get(4) || new Map();
    for (let column = FIRST_STOCK_COLUMN; column <= LAST_STOCK_COLUMN; column += 1) {
      const outlet = normalKey(tokenValue(headerCells.get(column), shared) || tokenValue(headerRow1.get(column), shared));
      if (!outlet) continue;
      const explicit = Number(tokenValue(headerRow4.get(column), shared));
      thresholds.set(outlet, Number.isFinite(explicit) && explicit > 0 ? explicit : defaultThreshold);
    }
    if (!thresholds.size) throw new Error("No outlet headers were found in Final!Detail G:AKD.");

    const formulaCellsChecked = validateFormulaBlock(detail);
    const items = new Map();
    let rowCount = 0;
    for (let rowNumber = 6; rowNumber <= detail.maxRow; rowNumber += 1) {
      const row = detail.rows.get(rowNumber);
      if (!row) continue;
      const code = normalKey(tokenValue(row.get(codeColumn), shared));
      if (!code) continue;
      const type = normalKey(tokenValue(row.get(typeColumn), shared));
      const prior = items.get(code) || {
        flags: Object.fromEntries(CRITERIA.map(([label]) => [label, false])),
        weights: Object.fromEntries(CRITERIA.map(([label]) => [label, 0])),
        rowCount: 0,
      };
      for (const [label, finalType] of CRITERIA) {
        if (type === finalType) {
          prior.flags[label] = true;
          prior.weights[label] += 1;
        }
      }
      prior.rowCount += 1;
      items.set(code, prior);
      rowCount += 1;
    }
    if (!items.size || !rowCount) throw new Error("Final!Detail contains no item rows.");

    const totals = Object.fromEntries(CRITERIA.map(([label]) => [label, 0]));
    items.forEach(item => CRITERIA.forEach(([label]) => { totals[label] += Number(item.weights[label] || 0); }));
    return {
      items, totals, thresholds, defaultThreshold, rowCount,
      uniqueItemCount: items.size,
      formulaCellsChecked,
      mode: MODE,
      sheetName: descriptor.detail.name,
    };
  }

  global.FinalAvailabilitySource = {
    MODE, CACHE_VERSION, CRITERIA,
    inspect,
    isFinalWorkbook: async file => Boolean(await inspect(file)),
    read,
    columnNumber,
    columnName,
  };
})(typeof window !== "undefined" ? window : globalThis);
