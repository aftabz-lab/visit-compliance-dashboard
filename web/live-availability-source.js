(function (global) {
  "use strict";

  const MODE = "operations-availability-live-v1";
  const CACHE_VERSION = 7;
  const SOURCE_PAGE = "https://operations-t.github.io/Availability-Report/";
  const SOURCE_URL = `${SOURCE_PAGE}data/dashboard.json`;
  const CRITERIA = [
    ["Core SKU", "CORE"],
    ["KVI SKU", "KVI"],
    ["Promo SKU", "PROMO"],
    ["HGPHS SKU", "HGPHS"],
  ];

  const normalText = value => String(value ?? "").trim();
  const normalKey = value => normalText(value).toUpperCase().replace(/[\s_-]+/g, " ");

  function labelForType(value) {
    const type = normalKey(value).replace(/\bITEMS?\b|\bSKUS?\b/g, "").replace(/\s+/g, " ").trim();
    if (type === "CORE") return "Core SKU";
    if (type === "KVI") return "KVI SKU";
    if (type === "PROMO" || type === "CORE PROMO") return "Promo SKU";
    if (type === "HGPHS" || type === "HGP HS") return "HGPHS SKU";
    return "";
  }

  function decodeBytes(encoded) {
    if (!encoded) return null;
    try {
      const raw = atob(encoded);
      const bytes = new Uint8Array(raw.length);
      for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
      return bytes;
    } catch {
      return null;
    }
  }

  function bitAt(bytes, index) {
    return bytes ? ((bytes[index >> 3] >> (index & 7)) & 1) : 0;
  }

  function emptyCell() {
    return { ok: 0, actual: 0, total: 0, pct: 0, pctActual: 0, supported: false };
  }

  function validate(data) {
    if (!data || !Array.isArray(data.outlets) || !data.outlets.length) {
      throw new Error("The live Availability Report contains no outlet rows.");
    }
    if (!Array.isArray(data.skus) || !data.skus.length) {
      throw new Error("The live Availability Report contains no SKU rows.");
    }
    const codes = data.detail_info?.reporting_outlet_codes;
    if (!Array.isArray(codes) || !codes.length) {
      throw new Error("The live Availability Report does not expose its reporting outlet order.");
    }
    return codes.map(code => normalText(code).toUpperCase()).filter(Boolean);
  }

  function build(data, fetchedAt = Date.now()) {
    const codes = validate(data);
    const outletByCode = new Map(data.outlets.map(row => [normalText(row?.outlet_code).toUpperCase(), row]));
    const entries = new Map();
    const sourceDirectory = new Map();
    const supportedLabels = new Set();

    for (const code of codes) {
      entries.set(code, Object.fromEntries(CRITERIA.map(([label]) => [label, emptyCell()])));
      const outlet = outletByCode.get(code) || {};
      sourceDirectory.set(code, {
        name: normalText(outlet.outlet_name),
        leader: normalText(outlet.leader),
        zone: normalText(outlet.zone),
        kvi: normalText(outlet.kvi),
      });
    }

    for (const sku of data.skus) {
      const label = labelForType(sku?.type);
      if (!label) continue;
      const bits = decodeBytes(sku?.stock_bits_b64);
      if (!bits || bits.length * 8 < codes.length) {
        throw new Error(`The live Availability Report has an incomplete outlet payload for SKU ${normalText(sku?.sku_code) || "(unknown)"}.`);
      }
      supportedLabels.add(label);
      for (let index = 0; index < codes.length; index += 1) {
        const cell = entries.get(codes[index])[label];
        cell.total += 1;
        if (bitAt(bits, index)) {
          cell.ok += 1;
          cell.actual += 1;
        }
      }
    }

    for (const entry of entries.values()) {
      for (const [label] of CRITERIA) {
        const cell = entry[label];
        cell.supported = supportedLabels.has(label);
        cell.pct = cell.total ? (100 * cell.ok / cell.total) : 0;
        cell.pctActual = cell.pct;
      }
    }

    const generatedAt = Date.parse(data.meta?.generated_at || "") || fetchedAt;
    return {
      version: CACHE_VERSION,
      mode: MODE,
      sourcePage: SOURCE_PAGE,
      sourceUrl: SOURCE_URL,
      sourceFile: normalText(data.meta?.source_file) || "Availability Report live data",
      sourceModified: normalText(data.meta?.source_modified),
      sourceGeneratedAt: normalText(data.meta?.generated_at),
      refreshLabel: normalText(data.meta?.refresh?.label),
      savedAt: generatedAt,
      fetchedAt,
      sourceOutlets: codes.length,
      sourceSkuRows: data.skus.length,
      sourceTypes: [...supportedLabels],
      entries: [...entries.entries()],
      sourceDirectory: [...sourceDirectory.entries()],
    };
  }

  async function fetchLatest({ signal } = {}) {
    const response = await fetch(`${SOURCE_URL}?_=${Date.now()}`, {
      cache: "no-store",
      mode: "cors",
      signal,
    });
    if (!response.ok) throw new Error(`Live Availability Report returned HTTP ${response.status}.`);
    return build(await response.json(), Date.now());
  }

  function isUsableCache(cache) {
    return Boolean(cache
      && Number(cache.version) === CACHE_VERSION
      && cache.mode === MODE
      && Array.isArray(cache.entries)
      && cache.entries.length);
  }

  global.LiveAvailabilitySource = {
    MODE,
    CACHE_VERSION,
    SOURCE_PAGE,
    SOURCE_URL,
    CRITERIA,
    labelForType,
    build,
    fetchLatest,
    isUsableCache,
  };
})(typeof window !== "undefined" ? window : globalThis);
