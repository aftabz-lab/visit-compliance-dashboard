/* Trend source fix: reads only Trend.xlsx / Trend.xlsm from the Trend analysis source. */
(function (global) {
  "use strict";

  const FILE_NAME_MATCH = /(^|[^a-z])trend([^a-z]|$)/i;
  const LAST_N = 6;

  function pickTrendFile(files) {
    return (files || []).find(f => {
      const name = String(f.name || "").toLowerCase().trim();
      return FILE_NAME_MATCH.test(name) &&
        (name.endsWith(".xlsx") || name.endsWith(".xlsm") || name === "trend");
    }) || null;
  }

  global.TrendSource = global.TrendSource || {};
  global.TrendSource.pickTrendFile = pickTrendFile;

})(typeof window !== "undefined" ? window : globalThis);
