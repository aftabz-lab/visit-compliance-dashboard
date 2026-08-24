import base64, json, math, re, struct, sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from zipfile import ZipFile

from lxml import etree
from openpyxl import load_workbook

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else "raw/Availability Report.xlsx")
STOCK_SRC = Path(sys.argv[2] if len(sys.argv) > 2 else "raw/Stock.xlsx")
OUT = Path("data/dashboard.json")
META_PATH = Path("raw/source_meta.json")
OUT.parent.mkdir(exist_ok=True)

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_DOC_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL_PKG_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
M = "{" + MAIN_NS + "}"
CELL_REF = re.compile(r"([A-Z]+)(\d+)")
DOS_DAYS = list(range(1, 31))


def clean(v):
    if v is None:
        return None
    return v.strip() if isinstance(v, str) else v


def norm(s):
    return re.sub(r"[^a-z0-9%]+", " ", str(s or "").strip().lower()).strip()


def num(v):
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    if isinstance(v, str):
        s = v.strip().replace(",", "")
        if s.endswith("%"):
            try:
                return float(s[:-1]) / 100
            except Exception:
                return None
        try:
            return float(s)
        except Exception:
            return None
    return None


def fraction(v):
    x = num(v)
    if x is None:
        return None
    return x / 100 if 1.000001 < x <= 100 else x


def serial(v):
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, (int, float)):
        if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            return None
        return v
    return v


def unique_headers(vals):
    out, seen = [], {}
    for i, v in enumerate(vals, 1):
        h = str(v).strip() if v not in (None, "") else f"Column {i}"
        seen[h] = seen.get(h, 0) + 1
        if seen[h] > 1:
            h = f"{h} ({seen[h]})"
        out.append(h)
    return out


def pick(headers, includes=(), exact=(), excludes=()):
    for h in headers:
        n = norm(h)
        if n in exact and not any(x in n for x in excludes):
            return h
    for h in headers:
        n = norm(h)
        if any(x in n for x in includes) and not any(x in n for x in excludes):
            return h
    return None


def col_index(ref):
    m = CELL_REF.match(ref or "")
    if not m:
        return None
    n = 0
    for ch in m.group(1):
        n = n * 26 + ord(ch) - 64
    return n


def load_shared_strings(z):
    if "xl/sharedStrings.xml" not in z.namelist():
        return []
    root = etree.fromstring(z.read("xl/sharedStrings.xml"))
    return ["".join(si.itertext()) for si in root.findall(M + "si")]


def sheet_xml_path(z, sheet_name):
    wb_root = etree.fromstring(z.read("xl/workbook.xml"))
    rid = None
    for sheet in wb_root.findall(".//" + M + "sheet"):
        if sheet.get("name") == sheet_name:
            rid = sheet.get("{" + REL_DOC_NS + "}id")
            break
    if not rid:
        return None
    rel_root = etree.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    target = None
    for rel in rel_root.findall("{" + REL_PKG_NS + "}Relationship"):
        if rel.get("Id") == rid:
            target = rel.get("Target")
            break
    if not target:
        return None
    target = target.lstrip("/")
    return target if target.startswith("xl/") else "xl/" + target


def xml_cell_value(cell, shared_strings):
    t = cell.get("t")
    if t == "inlineStr":
        is_node = cell.find(M + "is")
        return "".join(is_node.itertext()) if is_node is not None else None
    v = cell.find(M + "v")
    txt = v.text if v is not None else None
    if txt is None:
        return None
    if t == "s":
        try:
            return shared_strings[int(txt)]
        except Exception:
            return txt
    if t in ("str", "e"):
        return txt
    if t == "b":
        return txt == "1"
    try:
        x = float(txt)
        return int(x) if x.is_integer() else x
    except Exception:
        return txt


def read_sheet_rows(z, sheet_name, shared_strings, max_col=None, max_row=None):
    path = sheet_xml_path(z, sheet_name)
    if not path:
        return []
    rows = []
    with z.open(path) as stream:
        context = etree.iterparse(stream, events=("end",), tag=M + "row", huge_tree=True)
        for _, row in context:
            rn = int(row.get("r") or 0)
            if max_row is not None and rn > max_row:
                row.clear()
                break
            vals = {}
            for cell in row.findall(M + "c"):
                ci = col_index(cell.get("r"))
                if ci and (max_col is None or ci <= max_col):
                    vals[ci] = clean(xml_cell_value(cell, shared_strings))
            rows.append((rn, vals))
            row.clear()
            parent = row.getparent()
            if parent is not None:
                while row.getprevious() is not None:
                    del parent[0]
    return rows


def detect_header(rows, must_terms):
    best = (0, None, None)
    for rn, vals in rows:
        if rn > 30:
            break
        nv = [norm(v) for v in vals.values() if v not in (None, "")]
        score = sum(any(t in x for x in nv) for t in must_terms)
        nonblank = len(nv)
        rank = score * 100 + min(nonblank, 50)
        if score >= max(1, len(must_terms) // 2) and rank > best[0]:
            best = (rank, rn, vals)
    return best[1], best[2]


def occurrence_header(headers, original_vals, target_norm, occurrence=1, after_index=-1):
    seen = 0
    for i, v in enumerate(original_vals):
        if i <= after_index:
            continue
        if norm(v) == target_norm:
            seen += 1
            if seen == occurrence:
                return headers[i], i
    return None, None


def build_summary(z, sst):
    rows = read_sheet_rows(z, "Summary", sst, max_col=30, max_row=2000)
    if not rows:
        raise SystemExit("Required sheet 'Summary' not found or unreadable.")
    hr, hmap = detect_header(rows, ["assortment", "kvi", "avl"])
    if not hr:
        raise SystemExit("Could not detect the Summary header row.")
    max_col = max(hmap) if hmap else 1
    hvals = [hmap.get(i) for i in range(1, max_col + 1)]
    headers = unique_headers(hvals)

    code_h = pick(headers, includes=("outlet code", "store code"), exact=("code",))
    name_h = pick(headers, includes=("outlet name", "store name"), exact=("outlet", "name"))
    leader_h = pick(headers, includes=("leader",))
    kvi_h = pick(headers, includes=("kvi",))

    assort_h, assort_i = occurrence_header(headers, hvals, "assortment", 1)
    avail_h, avail_i = occurrence_header(headers, hvals, "avl qty", 1)
    avldos_h, avldos_i = occurrence_header(headers, hvals, "avl qty", 1, after_index=avail_i if avail_i is not None else -1)
    pct_h, _ = occurrence_header(headers, hvals, "%", 1, after_index=avail_i if avail_i is not None else -1)
    dospct_h, _ = occurrence_header(headers, hvals, "%", 1, after_index=avldos_i if avldos_i is not None else -1)

    if not code_h:
        code_h = headers[1] if len(headers) > 1 else headers[0]
    if not name_h:
        name_h = headers[2] if len(headers) > 2 else code_h

    row_lookup = {rn: vals for rn, vals in rows}
    dos_default_raw = num(row_lookup.get(6, {}).get(12))
    dos_default = int(round(dos_default_raw)) if dos_default_raw is not None else 1
    if dos_default not in DOS_DAYS:
        dos_default = 1
    stock_threshold = num(row_lookup.get(6, {}).get(6)) or 1

    outlets = []
    blank_run = 0
    for rn, vals in rows:
        if rn <= hr:
            continue
        rowvals = [vals.get(i) for i in range(1, max_col + 1)]
        if all(v in (None, "") for v in rowvals):
            blank_run += 1
            if blank_run >= 8:
                break
            continue
        blank_run = 0
        r = dict(zip(headers, rowvals))
        a = num(r.get(assort_h)) if assort_h else None
        av = num(r.get(avail_h)) if avail_h else None
        p = fraction(r.get(pct_h)) if pct_h else None
        if p is None and a not in (None, 0) and av is not None:
            p = av / a
        ad = num(r.get(avldos_h)) if avldos_h else None
        dp = fraction(r.get(dospct_h)) if dospct_h else None
        if dp is None and a not in (None, 0) and ad is not None:
            dp = ad / a
        code = r.get(code_h) if code_h else None
        name = r.get(name_h) if name_h else None
        if code in (None, "") and name in (None, "") and a is None and av is None:
            continue
        kv = r.get(kvi_h) if kvi_h else None
        if isinstance(kv, str) and kv.strip().upper() == "YES":
            kv = "Yes"
        outlets.append({
            "outlet_code": serial(code),
            "outlet_name": serial(name),
            "leader": serial(r.get(leader_h)) if leader_h else None,
            "assortment": a or 0,
            "available": av or 0,
            "availability": p if p is not None else 0,
            "source_avl_dos": ad,
            "source_dos_pct": dp,
            "kvi": serial(kv),
        })

    mapping = {
        "header_row": hr,
        "outlet_code": code_h,
        "outlet_name": name_h,
        "leader": leader_h,
        "assortment": assort_h,
        "available": avail_h,
        "availability": pct_h,
        "avl_dos": avldos_h,
        "dos_pct": dospct_h,
        "kvi": kvi_h,
    }
    return outlets, mapping, dos_default, stock_threshold


def build_zone(z, sst):
    rows = read_sheet_rows(z, "Zone", sst, max_col=30, max_row=100)
    if not rows:
        return [], []
    hr, hmap = detect_header(rows, ["leader", "outlet", "assortment"])
    if not hr:
        return [], []
    max_col = max(hmap) if hmap else 1
    hvals = [hmap.get(i) for i in range(1, max_col + 1)]
    headers = unique_headers(hvals)
    out = []
    for rn, vals in rows:
        if rn <= hr:
            continue
        rv = [vals.get(i) for i in range(1, max_col + 1)]
        if sum(v not in (None, "") for v in rv) < 2:
            continue
        out.append({k: serial(v) for k, v in zip(headers, rv)})
    return out, headers



def key_code(v):
    """Stable key for SKU/outlet codes coming from Excel numeric or text cells."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return str(v).strip().upper()
    if isinstance(v, (int, float)):
        try:
            if float(v).is_integer():
                return str(int(v))
        except Exception:
            pass
    s = str(v).strip()
    if re.fullmatch(r"\d+\.0+", s):
        s = s.split(".", 1)[0]
    return s.upper()


def load_stock_matrix(path):
    """Load Stock.xlsx as SKU -> compact outlet-value tuple.

    Expected layout follows the supplied Stock format: ProductCode, ProductName,
    then outlet-code columns. Missing/blank stock is normalized to zero.
    """
    if not path.exists():
        raise SystemExit(f"Required stock source not found: {path}")
    wb = load_workbook(path, read_only=True, data_only=True)
    ws = wb.active
    rows = ws.iter_rows(values_only=True)
    try:
        headers = next(rows)
    except StopIteration:
        raise SystemExit("Stock.xlsx is empty.")

    code_idx = None
    for i, h in enumerate(headers):
        n = norm(h)
        if n in {"productcode", "product code", "sku code", "item code", "code"}:
            code_idx = i
            break
    if code_idx is None:
        raise SystemExit("Stock.xlsx must contain a ProductCode column.")

    outlet_cols = []
    for i, h in enumerate(headers):
        if i == code_idx or h in (None, ""):
            continue
        k = key_code(h)
        if re.fullmatch(r"[A-Z]\d{3}", k):
            outlet_cols.append((i, k))
    if not outlet_cols:
        raise SystemExit("No outlet-code columns were detected in Stock.xlsx.")

    outlet_codes = [k for _, k in outlet_cols]
    dup_outlets = sorted({x for x in outlet_codes if outlet_codes.count(x) > 1})
    if dup_outlets:
        raise SystemExit(f"Duplicate outlet columns in Stock.xlsx: {', '.join(dup_outlets[:20])}")

    matrix = {}
    duplicate_skus = []
    for row in rows:
        if code_idx >= len(row):
            continue
        sku = key_code(row[code_idx])
        if not sku:
            continue
        vals = []
        for ci, _ in outlet_cols:
            v = row[ci] if ci < len(row) else None
            x = num(v)
            vals.append(0.0 if x is None else max(0.0, x))
        if sku in matrix:
            duplicate_skus.append(sku)
            continue
        matrix[sku] = tuple(vals)
    wb.close()
    if duplicate_skus:
        raise SystemExit(
            "Duplicate ProductCode rows found in Stock.xlsx. Resolve them before publishing: "
            + ", ".join(sorted(set(duplicate_skus))[:20])
        )
    return {
        "outlets": outlet_codes,
        "outlet_index": {c: i for i, c in enumerate(outlet_codes)},
        "rows": matrix,
        "sku_count": len(matrix),
        "outlet_count": len(outlet_codes),
    }


def availability_flag(v):
    x = num(v)
    return 1 if x is not None and x >= 1 else 0


def dos_score(stock, forecast, days):
    s = num(stock)
    f = num(forecast)
    s = 0.0 if s is None else s
    f = 0.0 if f is None else f
    threshold = (f / 30.0) * days
    if s >= threshold:
        return 1.0
    if threshold == 0:
        return 0.0
    return s / threshold


def extract_detail_analytics(z, sst, reporting_codes, dos_default, stock_threshold, stock_data, leader_by_code):
    """Fast Detail parser using external Stock.xlsx as the stock source.

    Availability Report.xlsx remains the master for SKU metadata, reporting outlets,
    Forecast and Summary/Zone structure. Stock.xlsx replaces Detail!I:AKD logically.
    Any missing SKU or outlet match is treated as zero stock.
    """
    skus = []
    detail_info = {
        "detail_outlets": 0,
        "reporting_outlets": 0,
        "excluded_detail_outlets": [],
        "missing_reporting_outlets": [],
        "sku_count": 0,
        "unique_detail_skus": 0,
        "dos_curve_days": DOS_DAYS,
        "stock_source": STOCK_SRC.name,
    }
    sheet_path = sheet_xml_path(z, "Detail")
    if not sheet_path:
        return skus, [], [], [], detail_info, {}, {}

    data = z.read(sheet_path)
    row_re = re.compile(br'<row\s+[^>]*\br="(\d+)"[^>]*>(.*?)</row>')
    cell_re = re.compile(br'<c\s+([^>]*)>(.*?)</c>')
    ref_re = re.compile(br'\br="([A-Z]+)(\d+)"')
    type_re = re.compile(br'\bt="([^"]+)"')
    v_re = re.compile(br'<v>(.*?)</v>')
    inline_re = re.compile(br'<t[^>]*>(.*?)</t>')
    col_cache = {}

    def colnum_bytes(letters):
        n = col_cache.get(letters)
        if n is not None:
            return n
        n = 0
        for ch in letters:
            n = n * 26 + ch - 64
        col_cache[letters] = n
        return n

    def fast_value(attrs, body):
        tm = type_re.search(attrs)
        t = tm.group(1) if tm else None
        if t == b'inlineStr':
            im = inline_re.search(body)
            return im.group(1).decode('utf-8', 'replace') if im else None
        vm = v_re.search(body)
        if not vm:
            return None
        txt_b = vm.group(1)
        if t == b's':
            try:
                return sst[int(txt_b)]
            except Exception:
                return txt_b.decode('utf-8', 'replace')
        txt = txt_b.decode('utf-8', 'replace')
        if t in (b'str', b'e'):
            return txt
        if t == b'b':
            return txt == '1'
        try:
            x = float(txt)
            return int(x) if x.is_integer() else x
        except Exception:
            return txt

    row4, header_values, meta_cols, block = {}, {}, {}, {}
    selected = []
    detail_codes = []
    detail_sku_keys = set()
    stock_skus_used = set()
    missing_stock_skus = set()
    outlet_curves = {str(c): [0.0] * len(DOS_DAYS) for c in reporting_codes}
    outlet_available = {str(c): 0 for c in reporting_codes}
    type_acc = defaultdict(lambda: {"sku_count": 0, "available": 0, "opportunities": 0})
    cat_acc = defaultdict(lambda: {"sku_count": 0, "available": 0, "opportunities": 0})
    l3_acc = defaultdict(lambda: {"sku_count": 0, "available": 0, "opportunities": 0})
    report_lookup = {key_code(c): str(c).strip() for c in reporting_codes if str(c).strip()}
    col_roles = None
    default_idx = DOS_DAYS.index(dos_default)
    stock_outlet_idx = stock_data["outlet_index"]
    stock_rows = stock_data["rows"]

    for rm in row_re.finditer(data):
        rn = int(rm.group(1))
        row_body = rm.group(2)

        if rn in (4, 5):
            vals = {}
            for cm in cell_re.finditer(row_body):
                refm = ref_re.search(cm.group(1))
                if not refm:
                    continue
                ci = colnum_bytes(refm.group(1))
                val = clean(fast_value(cm.group(1), cm.group(2)))
                if val not in (None, ""):
                    vals[ci] = val
            if rn == 4:
                row4 = vals
                for ci, val in row4.items():
                    n = norm(val)
                    if n == "stock": block["stock"] = ci
                    elif n == "avl qty": block["avl"] = ci
                    elif n == "forecast": block["forecast"] = ci
                    elif n == "avl dos": block["dos"] = ci
                    elif n == "dc dsd": block["dc_dsd"] = ci
                    elif n == "dc forecast": block["dc_forecast"] = ci
            else:
                header_values = vals
                for ci, val in header_values.items():
                    n = norm(val)
                    if n == "code": meta_cols["code"] = ci
                    elif n == "description": meta_cols["description"] = ci
                    elif n in {"l 3", "l3"}: meta_cols["l3"] = ci
                    elif n == "cat": meta_cols["cat"] = ci
                    elif n == "type": meta_cols["type"] = ci

                required_blocks = {"stock", "forecast", "dos"}
                if not required_blocks.issubset(block):
                    raise SystemExit(f"Detail blocks not fully detected: {block}")

                stock_map, fc_map = {}, {}
                for ci, val in header_values.items():
                    key = key_code(val)
                    if block["stock"] <= ci < block.get("avl", block["forecast"]):
                        stock_map[key] = ci
                        if key not in {"DK11", "DK14"}:
                            detail_codes.append(str(val).strip())
                    elif block["forecast"] <= ci < block["dos"]:
                        fc_map[key] = ci

                for key, original_code in report_lookup.items():
                    if key in stock_map and key in fc_map:
                        selected.append((original_code, fc_map[key]))

                mapped_codes = {c for c, _ in selected}
                detail_info["detail_outlets"] = len(set(detail_codes))
                detail_info["reporting_outlets"] = len(selected)
                detail_info["reporting_outlet_codes"] = [str(code).strip() for code, _ in selected]
                detail_info["sku_outlet_payload"] = "stock_bits_b64 + coverage_days_f32_b64 aligned to reporting_outlet_codes"
                detail_info["excluded_detail_outlets"] = sorted(set(detail_codes) - set(reporting_codes))
                detail_info["missing_reporting_outlets"] = sorted(set(reporting_codes) - mapped_codes)

                col_roles = {fci: i for i, (_, fci) in enumerate(selected)}
            continue

        if rn < 6 or not selected or col_roles is None:
            continue
        if rn > 2000:
            break

        nsel = len(selected)
        fc_vals = [None] * nsel
        meta_vals = {}

        for cm in cell_re.finditer(row_body):
            refm = ref_re.search(cm.group(1))
            if not refm:
                continue
            ci = colnum_bytes(refm.group(1))
            if ci in meta_cols.values():
                meta_vals[ci] = clean(fast_value(cm.group(1), cm.group(2)))
                continue
            idx = col_roles.get(ci)
            if idx is None:
                continue
            fc_vals[idx] = clean(fast_value(cm.group(1), cm.group(2)))

        code = meta_vals.get(meta_cols.get("code"))
        desc = meta_vals.get(meta_cols.get("description"))
        if code in (None, "") and desc in (None, ""):
            continue

        sku_key = key_code(code)
        detail_sku_keys.add(sku_key)
        stock_row = stock_rows.get(sku_key)
        if stock_row is None:
            missing_stock_skus.add(sku_key)
        else:
            stock_skus_used.add(sku_key)

        typ = meta_vals.get(meta_cols.get("type")) or "Unknown"
        cat = meta_vals.get(meta_cols.get("cat")) if meta_cols.get("cat") else None
        l3v = meta_vals.get(meta_cols.get("l3")) if meta_cols.get("l3") else None
        available = 0
        sku_curve = [0.0] * len(DOS_DAYS)
        # One byte per reporting outlet: 0 means no DOS shortfall through 30D;
        # 1..30 is the first DOS day on which this SKU/outlet becomes uncovered.
        # This compact representation lets the browser calculate UNIQUE affected
        # outlet counts for any DOS day, L-3 group, threshold set, and Leader filter.
        risk_days = bytearray(nsel)
        # Compact per-outlet payload used by the browser when SKU Analytics is
        # filtered by Outlet / Leader / KVI. stock_bits stores the normal stock
        # availability flag; coverage_days stores stock coverage in days as float32.
        # With coverage days c and selected DOS d, Excel-equivalent score is min(1,c/d).
        stock_bits = bytearray((nsel + 7) // 8)
        coverage_days = bytearray(nsel * 4)
        sku_leader_metrics = {}

        for i, (outlet_code, _) in enumerate(selected):
            oi = stock_outlet_idx.get(key_code(outlet_code))
            s = stock_row[oi] if stock_row is not None and oi is not None else 0.0
            f = num(fc_vals[i])
            f = 0.0 if f is None else f
            is_available = 1 if s >= stock_threshold else 0
            if is_available:
                stock_bits[i >> 3] |= (1 << (i & 7))
            # Forecast <= 0 is always fully DOS-covered under the workbook formula
            # because the threshold is zero and Stock >= 0. Store a large sentinel.
            coverage = 1_000_000.0 if f <= 0 else (30.0 * s / f)
            struct.pack_into("<f", coverage_days, i * 4, float(coverage))
            available += is_available
            outlet_available[outlet_code] += is_available
            out_curve = outlet_curves[outlet_code]
            leader_name = str(leader_by_code.get(str(outlet_code).strip()) or "Unassigned")
            leader_metric = sku_leader_metrics.setdefault(leader_name, {
                "available_outlets": 0,
                "total_outlets": 0,
                "dos_curve": [0.0] * len(DOS_DAYS),
            })
            leader_metric["available_outlets"] += is_available
            leader_metric["total_outlets"] += 1
            first_shortfall_day = 0
            for di, day in enumerate(DOS_DAYS):
                threshold = (f / 30.0) * day
                if s >= threshold:
                    score = 1.0
                elif threshold == 0:
                    score = 0.0
                else:
                    score = s / threshold
                if first_shortfall_day == 0 and score < 1.0:
                    first_shortfall_day = day
                sku_curve[di] += score
                out_curve[di] += score
                leader_metric["dos_curve"][di] += score
            risk_days[i] = first_shortfall_day

        total = nsel
        unavailable = max(0, total - available)
        availability = available / total if total else 0
        dos_avl_default = sku_curve[default_idx]
        skus.append({
            "sku_code": serial(code),
            "description": serial(desc),
            "l3": serial(l3v),
            "cat": serial(cat),
            "type": serial(typ),
            "available_outlets": available,
            "total_outlets": total,
            "availability": availability,
            "unavailable_outlets": unavailable,
            "dos_curve": [round(x, 6) for x in sku_curve],
            "dos_available_default": round(dos_avl_default, 6),
            "dos_pct_default": dos_avl_default / total if total else 0,
            "risk_days_b64": base64.b64encode(risk_days).decode("ascii"),
            "stock_bits_b64": base64.b64encode(stock_bits).decode("ascii"),
            "coverage_days_f32_b64": base64.b64encode(coverage_days).decode("ascii"),
            "leader_metrics": {
                leader: {
                    "available_outlets": int(metric["available_outlets"]),
                    "total_outlets": int(metric["total_outlets"]),
                    "availability": (metric["available_outlets"] / metric["total_outlets"] if metric["total_outlets"] else 0),
                    "dos_curve": [round(x, 6) for x in metric["dos_curve"]],
                }
                for leader, metric in sku_leader_metrics.items()
            },
        })

        for key, acc in (
            (str(typ), type_acc),
            (str(cat or "Unknown"), cat_acc),
            (str(l3v or "Unknown"), l3_acc),
        ):
            acc[key]["sku_count"] += 1
            acc[key]["available"] += available
            acc[key]["opportunities"] += total

    detail_info["sku_count"] = len(skus)
    detail_info["unique_detail_skus"] = len(detail_sku_keys)
    total_gaps = sum(s["unavailable_outlets"] for s in skus)
    for s in skus:
        s["gap_share"] = s["unavailable_outlets"] / total_gaps if total_gaps else 0

    stock_detail_outlets = {key_code(c) for c in detail_codes}
    stock_source_outlets = set(stock_outlet_idx)
    merge_info = {
        "stock_file": STOCK_SRC.name,
        "stock_skus": stock_data["sku_count"],
        "stock_outlets": stock_data["outlet_count"],
        "detail_sku_rows": len(skus),
        "detail_unique_skus": len(detail_sku_keys),
        "matched_unique_skus": len(detail_sku_keys & set(stock_rows)),
        "missing_skus": sorted(detail_sku_keys - set(stock_rows)),
        "extra_stock_skus": sorted(set(stock_rows) - detail_sku_keys),
        "detail_outlets": len(stock_detail_outlets),
        "matched_detail_outlets": len(stock_detail_outlets & stock_source_outlets),
        "missing_detail_outlets": sorted(stock_detail_outlets - stock_source_outlets),
        "extra_stock_outlets": sorted(stock_source_outlets - stock_detail_outlets),
        "rule": "Availability Detail!I:AKD is logically replaced by Stock.xlsx values; missing SKU/outlet match = 0.",
    }

    def finalize(acc, key_name):
        out = []
        for key, v in acc.items():
            opp = v["opportunities"]
            av = v["available"]
            gaps = max(0, opp - av)
            out.append({
                key_name: key,
                "sku_count": v["sku_count"],
                "available": av,
                "opportunities": opp,
                "availability": av / opp if opp else 0,
                "unavailable": gaps,
                "gap_share": gaps / total_gaps if total_gaps else 0,
            })
        return sorted(out, key=lambda x: (x["availability"], -x["unavailable"]))

    return (
        skus,
        finalize(type_acc, "type"),
        finalize(cat_acc, "cat"),
        finalize(l3_acc, "l3"),
        detail_info,
        {k: [round(x, 6) for x in v] for k, v in outlet_curves.items()},
        {"outlet_available": outlet_available, "merge_info": merge_info},
    )


# ---------- Read both source workbooks ----------
stock_data = load_stock_matrix(STOCK_SRC)
with ZipFile(SRC) as z:
    sst = load_shared_strings(z)
    outlets, mapping, dos_default, stock_threshold = build_summary(z, sst)
    zone, zone_headers = build_zone(z, sst)
    reporting_codes = {
        str(r.get("outlet_code") or "").strip()
        for r in outlets
        if str(r.get("outlet_code") or "").strip()
    }
    leader_by_code = {
        str(r.get("outlet_code") or "").strip(): str(r.get("leader") or "Unassigned")
        for r in outlets
        if str(r.get("outlet_code") or "").strip()
    }
    skus, sku_types, sku_cats, sku_l3, detail_info, outlet_curves, external_stock = extract_detail_analytics(
        z, sst, reporting_codes, dos_default, stock_threshold, stock_data, leader_by_code
    )
merge_info = external_stock.get("merge_info", {})
outlet_external_available = external_stock.get("outlet_available", {})

# Attach Stock.xlsx standard availability and dynamic DOS curves to outlet rows.
default_idx = DOS_DAYS.index(dos_default)
for r in outlets:
    code = str(r.get("outlet_code") or "").strip()
    r["source_available"] = r.get("available")
    r["source_availability"] = r.get("availability")
    r["available"] = float(outlet_external_available.get(code, 0))
    assort = float(r.get("assortment") or 0)
    r["availability"] = r["available"] / assort if assort else 0
    curve = outlet_curves.get(code, [0.0] * len(DOS_DAYS))
    r["dos_curve"] = curve
    r["avl_dos"] = curve[default_idx] if curve else 0
    r["dos_pct"] = r["avl_dos"] / assort if assort else 0

# ---------- Metadata and QA ----------
meta = {
    "source_file": f"{SRC.name} + {STOCK_SRC.name}",
    "availability_source_file": SRC.name,
    "stock_source_file": STOCK_SRC.name,
    "source_modified": datetime.fromtimestamp(max(SRC.stat().st_mtime, STOCK_SRC.stat().st_mtime), timezone.utc).isoformat() if SRC.exists() and STOCK_SRC.exists() else None,
}
if META_PATH.exists():
    try:
        sm = json.loads(META_PATH.read_text(encoding="utf-8"))
        avn = (sm.get("availability") or {}).get("name", SRC.name)
        stn = (sm.get("stock") or {}).get("name", STOCK_SRC.name)
        meta["source_file"] = f"{avn} + {stn}"
        meta["availability_source_file"] = avn
        meta["stock_source_file"] = stn
        meta["source_modified"] = sm.get("modifiedTime") or sm.get("retrievedAt") or meta["source_modified"]
    except Exception:
        pass
meta["generated_at"] = datetime.now(timezone.utc).isoformat()

unknown_kvi = sum(1 for r in outlets if str(r.get("kvi") or "").upper() in {"#N/A", "N/A", ""})
quality = [
    {"level": "good" if outlets else "bad", "title": "Summary rows loaded", "detail": f"{len(outlets):,} outlet rows exported from Summary."},
    {"level": "good", "title": "External stock merge enabled", "detail": f"Stock.xlsx replaces Detail!I:AKD logically before Availability and DOS are calculated. Missing matches are zero. DOS supports {DOS_DAYS[0]}-{DOS_DAYS[-1]} days; workbook default is {dos_default} day(s)."},
]
if unknown_kvi:
    quality.append({"level": "warn", "title": "KVI values need cleanup", "detail": f"{unknown_kvi:,} outlets have blank/N-A KVI values. The dashboard treats them as non-KVI/unknown."})

if skus:
    outlet_available_total = round(sum(float(r.get("available") or 0) for r in outlets))
    outlet_assort = round(sum(float(r.get("assortment") or 0) for r in outlets))
    sku_available = sum(int(s["available_outlets"]) for s in skus)
    sku_opps = sum(int(s["total_outlets"]) for s in skus)
    if sku_available == outlet_available_total and sku_opps == outlet_assort:
        quality.append({"level": "good", "title": "Stock merge reconciles across views", "detail": f"Stock.xlsx results reconcile exactly: {sku_available:,} available across {sku_opps:,} outlet-SKU opportunities."})
    else:
        quality.append({"level": "bad", "title": "Stock merge reconciliation mismatch", "detail": f"SKU matrix={sku_available:,}/{sku_opps:,}; outlet aggregation={outlet_available_total:,}/{outlet_assort:,}."})

    ms = merge_info.get("matched_unique_skus", 0)
    us = merge_info.get("detail_unique_skus", 0)
    mo = merge_info.get("matched_detail_outlets", 0)
    do = merge_info.get("detail_outlets", 0)
    missing_skus = merge_info.get("missing_skus") or []
    missing_outlets = merge_info.get("missing_detail_outlets") or []
    extra_outlets = merge_info.get("extra_stock_outlets") or []
    quality.append({"level": "good" if not missing_skus else "warn", "title": "Stock SKU match", "detail": f"{ms:,}/{us:,} unique Availability item codes matched Stock.xlsx. {len(missing_skus):,} unmatched item codes are treated as zero stock."})
    quality.append({"level": "good" if not missing_outlets else "warn", "title": "Stock outlet match", "detail": f"{mo:,}/{do:,} Availability stock outlets matched Stock.xlsx. {len(missing_outlets):,} unmatched outlet columns are treated as zero stock; {len(extra_outlets):,} extra Stock.xlsx outlets are ignored."})
    quality.append({"level": "good", "title": "DOS recalculated from Stock.xlsx", "detail": "Cached Availability workbook stock/AVL-DOS values are intentionally ignored; DOS is rebuilt from Stock.xlsx plus the Forecast matrix using the Summary!L6 rule."})

    excluded = detail_info.get("excluded_detail_outlets") or []
    if excluded:
        quality.append({"level": "warn", "title": "Detail outlets excluded from reporting universe", "detail": f"{len(excluded):,} Detail outlets are not present in Summary and are excluded from dashboard KPIs: {', '.join(excluded[:10])}{'…' if len(excluded) > 10 else ''}."})
    missing = detail_info.get("missing_reporting_outlets") or []
    if missing:
        quality.append({"level": "bad", "title": "Summary outlets missing from Detail mapping", "detail": f"{len(missing):,} Summary outlets could not be mapped to Forecast blocks: {', '.join(missing[:10])}{'…' if len(missing) > 10 else ''}."})
else:
    quality.append({"level": "bad", "title": "SKU/DOS analytics not built", "detail": "The Detail Stock, Forecast, and AVL matrices could not be mapped."})

payload = {
    "meta": meta,
    "dos": {
        "source_cell": "Summary!L6",
        "default_days": dos_default,
        "supported_days": DOS_DAYS,
        "stock_availability_threshold": stock_threshold,
        "formula": "IF(Stock >= Forecast/30*DOS Days, 1, Stock/(Forecast/30*DOS Days))",
    },
    "outlets": outlets,
    "zone_headers": zone_headers,
    "zone": zone,
    "sku_types": sku_types,
    "sku_categories": sku_cats,
    "sku_l3": sku_l3,
    "sku_leaders": sorted({str(r.get("leader") or "Unassigned") for r in outlets}),
    "skus": skus,
    "detail_info": detail_info,
    "stock_merge": merge_info,
    "quality": quality,
    "mapping": mapping,
}
OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(f"Built {OUT}: {len(outlets)} outlets, {len(skus)} SKU rows, stock={STOCK_SRC.name}, DOS {DOS_DAYS[0]}-{DOS_DAYS[-1]} days, default={dos_default}")
