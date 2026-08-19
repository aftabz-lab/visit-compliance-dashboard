from __future__ import annotations

import json
import re
import shutil
import unicodedata
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
WEB_DIR = ROOT / "web"
SITE_DIR = ROOT / "site"
CONFIG_PATH = ROOT / "config" / "dashboard.config.json"
ALIAS_PATH = ROOT / "config" / "officer_aliases.json"

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
OFFICE_REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"

SCHEDULE_SCHEMAS = [
    {"sheet": "Zonal", "status": "Zonal", "officer_header": "Zonal HR Name"},
    {"sheet": "RHO", "status": "RHO", "officer_header": "Regional Head HR Name"},
]
RESPONSE_SHEET = "Response Summary"
RESPONSE_HEADERS = ["Response ID", "Date", "Time", "Site Code", "Created By User ID"]

# The Audit page intentionally publishes only the fields it needs to score and
# group answers.  This keeps the static fallback small and excludes the rest of
# the response export (for example coordinates and submitter information).
AUDIT_FIELDS = [
    "Response ID",
    "Site Code",
    "Question Category",
    "Question Title",
    "Question Max Score",
    "Answer Score",
    "Date",
]
AUDIT_REQUIRED_HEADERS = set(AUDIT_FIELDS) - {"Date"}


def normalize_text(value: object) -> str:
    text = unicodedata.normalize("NFKC", str(value if value is not None else ""))
    return re.sub(r"\s+", " ", text).strip()


def name_key(value: object) -> str:
    return normalize_text(value).casefold()


def loose_name_key(value: object) -> str:
    text = re.sub(r"[.,'’`\"()\-_/\\]+", " ", name_key(value))
    return re.sub(r"\s+", " ", text).strip()


def site_key(value: object) -> str:
    return normalize_text(value).upper()


def column_index(cell_ref: str) -> int:
    match = re.match(r"([A-Z]+)", cell_ref)
    if not match:
        return 0
    n = 0
    for ch in match.group(1):
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def excel_serial_to_date(value: float, *, date_1904: bool) -> date:
    epoch = datetime(1904, 1, 1) if date_1904 else datetime(1899, 12, 30)
    return (epoch + timedelta(days=float(value))).date()


def parse_date_only(value: object, *, date_1904: bool = False) -> str | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        try:
            return excel_serial_to_date(float(value), date_1904=date_1904).isoformat()
        except (ValueError, OverflowError):
            return None
    text = normalize_text(value)
    if not text:
        return None
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%d-%m-%Y", "%d-%b-%Y", "%d-%b-%y"):
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            pass
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        return None


class XlsxWorkbook:
    def __init__(self, path: Path):
        self.path = path
        self.z = zipfile.ZipFile(path)
        self.shared_strings = self._read_shared_strings()
        self.sheets, self.date_1904 = self._read_workbook_metadata()

    def close(self) -> None:
        self.z.close()

    def _read_shared_strings(self) -> list[str]:
        if "xl/sharedStrings.xml" not in self.z.namelist():
            return []
        root = ET.fromstring(self.z.read("xl/sharedStrings.xml"))
        return ["".join(t.text or "" for t in si.iter(NS + "t")) for si in root.findall(NS + "si")]

    def _read_workbook_metadata(self) -> tuple[dict[str, str], bool]:
        workbook = ET.fromstring(self.z.read("xl/workbook.xml"))
        rels = ET.fromstring(self.z.read("xl/_rels/workbook.xml.rels"))
        rel_map = {r.attrib["Id"]: r.attrib["Target"] for r in rels}
        sheets: dict[str, str] = {}
        sheets_node = workbook.find(NS + "sheets")
        if sheets_node is not None:
            for sheet in sheets_node:
                target = rel_map[sheet.attrib[OFFICE_REL]]
                # Excel writers use either "worksheets/sheet1.xml" or
                # "/xl/worksheets/sheet1.xml" here.  Normalise both forms
                # before opening the ZIP member.
                target = target.lstrip("/")
                if not target.startswith("xl/"):
                    target = "xl/" + target
                sheets[sheet.attrib["name"]] = target
        workbook_pr = workbook.find(NS + "workbookPr")
        date_1904 = bool(workbook_pr is not None and workbook_pr.attrib.get("date1904") in {"1", "true", "True"})
        return sheets, date_1904

    def iter_rows(self, sheet_name: str):
        sheet_path = self.sheets.get(sheet_name)
        if not sheet_path:
            raise KeyError(sheet_name)
        with self.z.open(sheet_path) as stream:
            for _, elem in ET.iterparse(stream, events=("end",)):
                if elem.tag != NS + "row":
                    continue
                cells: dict[int, object] = {}
                for cell in elem.findall(NS + "c"):
                    idx = column_index(cell.attrib.get("r", "A1"))
                    cell_type = cell.attrib.get("t")
                    value_node = cell.find(NS + "v")
                    value: object = None if value_node is None else (value_node.text or "")
                    if cell_type == "s" and value is not None:
                        value = self.shared_strings[int(value)]
                    elif cell_type == "inlineStr":
                        inline = cell.find(NS + "is")
                        value = "".join(t.text or "" for t in inline.iter(NS + "t")) if inline is not None else ""
                    elif cell_type in {"str", "d"}:
                        value = value or ""
                    elif cell_type == "b":
                        value = value == "1"
                    elif value is not None:
                        try:
                            number = float(value)
                            value = int(number) if number.is_integer() else number
                        except (TypeError, ValueError):
                            pass
                    cells[idx] = value
                if cells:
                    yield [cells.get(i) for i in range(max(cells) + 1)]
                elem.clear()

    def first_row(self, sheet_name: str) -> list[object]:
        return next(self.iter_rows(sheet_name), [])


def read_json(path: Path, fallback):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else fallback


def static_header_set(row: list[object]) -> set[str]:
    return {normalize_text(v) for v in row if normalize_text(v)}


def is_schedule_workbook(book: XlsxWorkbook) -> bool:
    for schema in SCHEDULE_SCHEMAS:
        if schema["sheet"] not in book.sheets:
            return False
        headers = static_header_set(book.first_row(schema["sheet"]))
        required = {"SL", "CODE", "Outlet Name", schema["officer_header"]}
        if not required.issubset(headers):
            return False
    return True


def is_response_workbook(book: XlsxWorkbook) -> bool:
    """Identify the response export without relying on its file name.

    Only the worksheet named ``Response Summary`` is inspected.  Other sheets
    in the workbook are deliberately ignored for Visit Compliance calculations.
    """
    if RESPONSE_SHEET not in book.sheets:
        return False
    headers = static_header_set(book.first_row(RESPONSE_SHEET))
    return set(RESPONSE_HEADERS).issubset(headers)


def workbook_role(book: XlsxWorkbook) -> str:
    schedule_ok = is_schedule_workbook(book)
    response_ok = is_response_workbook(book)
    if schedule_ok and response_ok:
        return "both"
    if schedule_ok:
        return "schedule"
    if response_ok:
        return "responses"
    return "unknown"


DATE_IN_NAME = re.compile(r"(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})")


class IncompleteInputError(RuntimeError):
    """Raised when no complete, current schedule/response pair is available."""


def _recency_key(path: Path):
    """Newest-first ordering: a date in the filename wins, then file mtime.

    Uploading a fresh export next to last month's copy is the normal workflow, so
    the newer file should simply take over rather than breaking the build.
    """
    match = DATE_IN_NAME.search(path.name)
    stamp = ""
    if match:
        year, month, day = match.groups()
        try:
            stamp = date(int(year), int(month), int(day)).isoformat()
        except ValueError:
            stamp = ""
    return (stamp, path.stat().st_mtime, path.name)


def _pick_latest(paths: list[Path], role: str) -> tuple[Path, list[Path]]:
    if not paths:
        raise IncompleteInputError(
            f"No {role} workbook found in data/. Check that the file still has its "
            f"expected sheets and column headers."
        )
    ordered = sorted(paths, key=_recency_key, reverse=True)
    return ordered[0], ordered[1:]


def response_sheet_freshness(path: Path) -> tuple[str, int]:
    """Return the latest actual response date and populated row count.

    Response export filenames are not reliable: users commonly upload a new
    workbook with a generic name alongside an older file whose filename has a
    date.  Select the source from the exact ``Response Summary`` contents so
    the latest data wins regardless of the filename.
    """
    book = XlsxWorkbook(path)
    try:
        rows = book.iter_rows(RESPONSE_SHEET)
        header = next(rows, None)
        if not header:
            return "", 0
        header_map = {normalize_text(value): index for index, value in enumerate(header) if normalize_text(value)}
        date_index = header_map.get("Date")
        latest_response_date = ""
        populated_rows = 0
        for row in rows:
            if not any(normalize_text(value) for value in row):
                continue
            populated_rows += 1
            raw_date = row[date_index] if date_index is not None and date_index < len(row) else None
            response_date = parse_date_only(raw_date, date_1904=book.date_1904)
            if response_date and response_date > latest_response_date:
                latest_response_date = response_date
        return latest_response_date, populated_rows
    finally:
        book.close()


def _response_freshness_key(path: Path):
    latest_response_date, populated_rows = response_sheet_freshness(path)
    # The file name is deliberately only the final tie-breaker.  Actual latest
    # response date and response volume define which source is the freshest.
    return latest_response_date, populated_rows, path.stat().st_mtime, path.name


def _pick_freshest_response(paths: list[Path]) -> tuple[Path, list[Path]]:
    if not paths:
        raise IncompleteInputError(
            f"No response workbook found in data/. Check that the file still has the exact '{RESPONSE_SHEET}' sheet and required headers."
        )
    ordered = sorted(paths, key=_response_freshness_key, reverse=True)
    return ordered[0], ordered[1:]


def discover_inputs() -> tuple[Path | None, Path, list[str]]:
    files = sorted(
        p for p in DATA_DIR.iterdir()
        if p.is_file() and not p.name.startswith("~$") and p.suffix.lower() in {".xlsx", ".xlsm"}
    )
    if not files:
        raise IncompleteInputError(
            "A fresh build needs a schedule workbook and a response workbook. "
            "No Excel files were found."
        )
    classified: list[tuple[Path, str]] = []
    for path in files:
        try:
            book = XlsxWorkbook(path)
            try:
                role = workbook_role(book)
            finally:
                book.close()
        except (zipfile.BadZipFile, KeyError, ET.ParseError) as exc:
            # An unrelated or incomplete Excel upload must never erase the
            # published dashboard.  Ignore it and retain the last good output.
            print(f"note: ignoring unreadable Excel file {path.name}: {exc}")
            classified.append((path, "unknown"))
            continue
        classified.append((path, role))

    schedule_candidates = [p for p, role in classified if role in {"schedule", "both"}]
    response_candidates = [p for p, role in classified if role in {"responses", "both"}]

    responses, older_responses = _pick_freshest_response(response_candidates)
    schedule: Path | None = None
    older_schedules: list[Path] = []
    if schedule_candidates:
        schedule, older_schedules = _pick_latest(schedule_candidates, "schedule")
    else:
        print("note: no raw schedule workbook found; a valid retained schedule snapshot will be used when available")

    # A combined workbook is valid: schedule rows come only from Zonal/RHO,
    # while response rows come only from the exact Response Summary sheet.
    superseded = list(dict.fromkeys(p.name for p in older_schedules + older_responses))
    for name in superseded:
        print(f"note: ignoring older workbook {name}")
    return schedule, responses, superseded


def _audit_header_map(row: list[object]) -> dict[str, int] | None:
    """Return the audit column positions when a sheet is Answer Details-like."""
    headers = {normalize_text(value): index for index, value in enumerate(row) if normalize_text(value)}
    if not AUDIT_REQUIRED_HEADERS.issubset(headers):
        return None
    return headers


def _audit_value(value: object, field: str) -> object:
    """Keep numeric scores numeric while normalising user-entered text."""
    if value is None:
        return ""
    if isinstance(value, str):
        return site_key(value) if field == "Site Code" else normalize_text(value)
    return value


def extract_audit_snapshot(path: Path) -> dict | None:
    """Extract the compact, public Audit-page payload from one workbook.

    The audit export is optional for the main visit dashboard, so a workbook
    without an Answer Details sheet simply returns ``None``.
    """
    book = XlsxWorkbook(path)
    try:
        for sheet_name in book.sheets:
            rows = book.iter_rows(sheet_name)
            header = next(rows, None)
            if not header:
                continue
            header_map = _audit_header_map(header)
            if header_map is None:
                continue

            packed_rows: list[list[object]] = []
            for row in rows:
                packed = [
                    _audit_value(row[header_map[field]] if header_map.get(field, -1) < len(row) else None, field)
                    if field in header_map else ""
                    for field in AUDIT_FIELDS
                ]
                if any(value not in (None, "") for value in packed):
                    packed_rows.append(packed)

            if not packed_rows:
                raise RuntimeError(f'"{sheet_name}" in {path.name} has no audit answer rows.')

            return {
                "metadata": {
                    "sourceFile": path.name,
                    "sourceSheet": sheet_name,
                    "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                    "answerCount": len(packed_rows),
                },
                "fields": AUDIT_FIELDS,
                "rows": packed_rows,
            }
    finally:
        book.close()
    return None


def discover_audit_snapshot(paths: list[Path]) -> dict | None:
    """Use the newest audit workbook when several raw workbooks are present."""
    for path in sorted(paths, key=_recency_key, reverse=True):
        try:
            snapshot = extract_audit_snapshot(path)
        except (zipfile.BadZipFile, KeyError, ET.ParseError, RuntimeError) as exc:
            print(f"note: could not use {path.name} for the Audit snapshot: {exc}")
            continue
        if snapshot is not None:
            print(f"Audit snapshot: {path.name} ({snapshot['metadata']['answerCount']:,} answers)")
            return snapshot
    return None


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")


def ensure_last_good_copy(primary: Path, fallback: Path) -> None:
    """Create a permanent fallback only when a valid primary snapshot exists."""
    if primary.exists() and primary.stat().st_size and not fallback.exists():
        shutil.copyfile(primary, fallback)


def saved_audit_assets() -> dict[str, bytes]:
    """Hold audit snapshots while a fresh visit-dashboard build recreates site/."""
    assets: dict[str, bytes] = {}
    for filename in ("audit_data.json", "audit_data_last_good.json"):
        path = SITE_DIR / "data" / filename
        if path.exists() and path.stat().st_size:
            assets[filename] = path.read_bytes()
    return assets


def restore_audit_assets(assets: dict[str, bytes]) -> None:
    target_dir = SITE_DIR / "data"
    target_dir.mkdir(parents=True, exist_ok=True)
    for filename, content in assets.items():
        (target_dir / filename).write_bytes(content)


def preserve_published_snapshots(audit_snapshot: dict | None, reason: str) -> None:
    """Refresh web assets without ever replacing a last successful snapshot.

    This is intentionally used not only when the raw folder is empty, but also
    when one of the two required inputs has been deleted or an unrelated Excel
    workbook has been uploaded.  A partial raw upload must not blank the live
    dashboard.
    """
    existing_data = SITE_DIR / "data" / "dashboard_data.json"
    if not existing_data.exists() or not existing_data.stat().st_size:
        raise RuntimeError(
            f"{reason} There is no previous site/data/dashboard_data.json yet. "
            "Run one successful build with the schedule workbook and a response workbook "
            f"containing the '{RESPONSE_SHEET}' sheet first."
        )

    # Refresh the application files (including the snapshot-status box) while
    # deliberately retaining site/data from the prior successful calculation.
    shutil.copytree(WEB_DIR, SITE_DIR, dirs_exist_ok=True)
    site_data = SITE_DIR / "data"
    site_data.mkdir(parents=True, exist_ok=True)
    ensure_last_good_copy(
        site_data / "dashboard_data.json",
        site_data / "dashboard_data_last_good.json",
    )
    if audit_snapshot is not None:
        write_json(site_data / "audit_data.json", audit_snapshot)
        write_json(site_data / "audit_data_last_good.json", audit_snapshot)
    else:
        ensure_last_good_copy(
            site_data / "audit_data.json",
            site_data / "audit_data_last_good.json",
        )
    (SITE_DIR / ".nojekyll").write_text("", encoding="utf-8")
    print(f"{reason} Keeping the last successfully generated dashboard and Audit snapshots.")


def load_retained_schedule() -> tuple[list[dict], dict[str, dict], str]:
    """Reuse the last saved plan when only a fresh response file is uploaded.

    The published dashboard already stores every officer/outlet/date assignment
    in its detail payload.  This lets a new ``Response Summary`` workbook
    refresh the dashboard even after the raw schedule workbook has been
    removed, while still preserving the prior snapshot when no response file is
    available at all.
    """
    snapshot_path = SITE_DIR / "data" / "dashboard_data.json"
    if not snapshot_path.exists() or not snapshot_path.stat().st_size:
        raise IncompleteInputError(
            "No raw schedule workbook was found and there is no saved schedule snapshot yet. "
            "Upload the schedule workbook once together with a response workbook."
        )
    try:
        snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise IncompleteInputError(f"Could not read the saved schedule snapshot: {exc}") from exc

    officer_by_key = {
        normalize_text(row.get("officerKey")): row
        for row in snapshot.get("officers", [])
        if isinstance(row, dict) and normalize_text(row.get("officerKey"))
    }
    details = snapshot.get("details")
    if not officer_by_key or not isinstance(details, dict):
        raise IncompleteInputError("The saved dashboard does not contain a reusable schedule snapshot.")

    outlet_dir: dict[str, dict] = {}
    for raw_site_code, raw_entry in snapshot.get("outlets", {}).items():
        entry = raw_entry if isinstance(raw_entry, dict) else {}
        site_code = site_key(entry.get("siteCode") or raw_site_code)
        if not site_code:
            continue
        outlet_dir[site_code] = {
            "siteCode": site_code,
            "outletName": normalize_text(entry.get("outletName")),
            "rhoName": normalize_text(entry.get("rhoName")),
            "zonalName": normalize_text(entry.get("zonalName")),
        }

    assignments: list[dict] = []
    seen: set[str] = set()
    for officer_key, detail in details.items():
        officer_record = officer_by_key.get(normalize_text(officer_key))
        if not officer_record or not isinstance(detail, dict):
            continue
        status = normalize_text(officer_record.get("status"))
        officer = normalize_text(officer_record.get("officer"))
        if not status or not officer:
            continue
        for planned in detail.get("planned", []):
            if not isinstance(planned, dict):
                continue
            site_code = site_key(planned.get("siteCode"))
            planned_date = parse_date_only(planned.get("plannedDate"))
            outlet_name = normalize_text(planned.get("outletName"))
            if not site_code or not planned_date:
                continue
            assignment_key = f"{status.casefold()}::{name_key(officer)}|{site_code}|{planned_date}"
            if assignment_key in seen:
                continue
            seen.add(assignment_key)
            assignments.append({
                "status": status,
                "officer": officer,
                "officerNameKey": name_key(officer),
                "officerLooseKey": loose_name_key(officer),
                "siteCode": site_code,
                "outletName": outlet_name,
                "plannedDate": planned_date,
            })
            entry = outlet_dir.setdefault(
                site_code,
                {"siteCode": site_code, "outletName": "", "rhoName": "", "zonalName": ""},
            )
            if outlet_name and not entry["outletName"]:
                entry["outletName"] = outlet_name
            if status == "RHO" and officer and not entry["rhoName"]:
                entry["rhoName"] = officer
            if status == "Zonal" and officer and not entry["zonalName"]:
                entry["zonalName"] = officer

    if not assignments:
        raise IncompleteInputError("The saved dashboard contains no reusable planned visits.")
    schedule_file = normalize_text(snapshot.get("metadata", {}).get("scheduleFile")) or "Retained dashboard schedule"
    return assignments, outlet_dir, schedule_file


def parse_schedule(path: Path, planned_values: list[str]) -> tuple[list[dict], dict[str, dict]]:
    planned_set = {name_key(v) for v in planned_values}
    book = XlsxWorkbook(path)
    assignments: list[dict] = []
    outlet_dir: dict[str, dict] = {}
    try:
        for schema in SCHEDULE_SCHEMAS:
            rows = book.iter_rows(schema["sheet"])
            header = next(rows, None)
            if not header:
                raise RuntimeError(f"Schedule sheet {schema['sheet']} is empty.")
            static_map = {normalize_text(v): i for i, v in enumerate(header) if normalize_text(v)}
            for required in ("SL", "CODE", "Outlet Name", schema["officer_header"]):
                if required not in static_map:
                    raise RuntimeError(f"Schedule sheet {schema['sheet']} is missing header: {required}")
            date_columns: list[tuple[int, str]] = []
            for i, value in enumerate(header):
                normalized = normalize_text(value)
                if normalized in {"SL", "CODE", "Outlet Name", schema["officer_header"]}:
                    continue
                parsed = parse_date_only(value, date_1904=book.date_1904)
                if parsed:
                    date_columns.append((i, parsed))
                elif normalized:
                    raise RuntimeError(f"Unexpected non-date schedule header in {schema['sheet']}: {normalized}")
            if not date_columns:
                raise RuntimeError(f"No schedule date columns found in {schema['sheet']}.")
            for excel_row, row in enumerate(rows, start=2):
                def get(header_name: str):
                    i = static_map[header_name]
                    return row[i] if i < len(row) else None
                site_code = site_key(get("CODE"))
                outlet_name = normalize_text(get("Outlet Name"))
                officer = normalize_text(get(schema["officer_header"]))
                if not site_code and not officer:
                    continue
                if site_code:
                    entry = outlet_dir.setdefault(
                        site_code,
                        {"siteCode": site_code, "outletName": "", "rhoName": "", "zonalName": ""},
                    )
                    if outlet_name and not entry["outletName"]:
                        entry["outletName"] = outlet_name
                    if officer:
                        if schema["status"] == "RHO":
                            entry["rhoName"] = officer
                        elif schema["status"] == "Zonal":
                            entry["zonalName"] = officer
                for i, planned_date in date_columns:
                    value = row[i] if i < len(row) else None
                    if name_key(value) in planned_set:
                        if not site_code or not officer:
                            raise RuntimeError(f"Blank CODE or officer in planned row {excel_row} of {schema['sheet']}.")
                        assignments.append({
                            "status": schema["status"],
                            "officer": officer,
                            "officerNameKey": name_key(officer),
                            "officerLooseKey": loose_name_key(officer),
                            "siteCode": site_code,
                            "outletName": outlet_name,
                            "plannedDate": planned_date,
                        })
    finally:
        book.close()
    seen: set[str] = set()
    for a in assignments:
        key = f"{a['status'].lower()}::{a['officerNameKey']}|{a['siteCode']}|{a['plannedDate']}"
        if key in seen:
            raise RuntimeError(f"Duplicate planned assignment: {a['status']} / {a['officer']} / {a['siteCode']} / {a['plannedDate']}")
        seen.add(key)
    return assignments, outlet_dir


def parse_responses(path: Path, acceptance: dict) -> tuple[list[dict], dict]:
    book = XlsxWorkbook(path)
    accepted: list[dict] = []
    seen_ids: set[str] = set()
    duplicate_ids = 0
    rejected = 0
    try:
        # Never scan any other sheet from the response workbook.  The export
        # filename may change every month; the exact Response Summary tab is
        # the stable and only accepted Visit Compliance source.
        rows = book.iter_rows(RESPONSE_SHEET)
        header = next(rows, None)
        if not header:
            raise RuntimeError(f"{RESPONSE_SHEET} is empty.")
        header_map = {normalize_text(v): i for i, v in enumerate(header) if normalize_text(v)}
        for required in RESPONSE_HEADERS:
            if required not in header_map:
                raise RuntimeError(f"{RESPONSE_SHEET} is missing header: {required}")
        for row in rows:
            def get(header_name: str):
                i = header_map[header_name]
                return row[i] if i < len(row) else None
            response_id = normalize_text(get("Response ID"))
            response_date = parse_date_only(get("Date"), date_1904=book.date_1904)
            site_code = site_key(get("Site Code"))
            officer = normalize_text(get("Created By User ID"))
            if not any((response_id, response_date, site_code, officer)):
                continue
            if (
                (acceptance.get("requireResponseId", True) and not response_id)
                or (acceptance.get("requireDate", True) and not response_date)
                or (acceptance.get("requireSiteCode", True) and not site_code)
                or (acceptance.get("requireOfficer", True) and not officer)
            ):
                rejected += 1
                continue
            if acceptance.get("deduplicateByResponseId", True) and response_id in seen_ids:
                duplicate_ids += 1
                continue
            seen_ids.add(response_id)
            accepted.append({
                "responseId": response_id,
                "responseDate": response_date,
                "siteCode": site_code,
                "officer": officer,
                "officerNameKey": name_key(officer),
                "officerLooseKey": loose_name_key(officer),
            })
    finally:
        book.close()
    return accepted, {"duplicateResponseIdsIgnored": duplicate_ids, "rejectedResponseRows": rejected}


def one(values: set[str] | None) -> str | None:
    return next(iter(values)) if values and len(values) == 1 else None


def resolve_responses(responses: list[dict], assignments: list[dict], aliases: list[dict]):
    officers: dict[str, dict] = {}
    by_name: dict[str, set[str]] = defaultdict(set)
    by_loose: dict[str, set[str]] = defaultdict(set)
    by_name_site: dict[tuple[str, str], set[str]] = defaultdict(set)
    by_loose_site: dict[tuple[str, str], set[str]] = defaultdict(set)
    for a in assignments:
        officer_key = f"{a['status'].lower()}::{a['officerNameKey']}"
        officers.setdefault(officer_key, {"officerKey": officer_key, "status": a["status"], "officer": a["officer"]})
        by_name[a["officerNameKey"]].add(officer_key)
        by_loose[a["officerLooseKey"]].add(officer_key)
        by_name_site[(a["officerNameKey"], a["siteCode"])].add(officer_key)
        by_loose_site[(a["officerLooseKey"], a["siteCode"])].add(officer_key)

    alias_map: dict[str, str] = {}
    for alias in aliases:
        target = [
            key for key, officer in officers.items()
            if officer["status"] == alias["status"] and loose_name_key(officer["officer"]) == loose_name_key(alias["target"])
        ]
        if len(target) != 1:
            raise RuntimeError(f"Alias target is not unique/found: {alias['source']} -> {alias['status']} / {alias['target']}")
        alias_map[loose_name_key(alias["source"])] = target[0]

    resolution_counts: Counter = Counter()
    resolved: list[dict] = []
    for response in responses:
        officer_key = one(by_name.get(response["officerNameKey"]))
        method = "exact_name" if officer_key else None
        if not officer_key:
            officer_key = one(by_loose.get(response["officerLooseKey"]))
            method = "loose_name" if officer_key else None
        if not officer_key:
            officer_key = one(by_name_site.get((response["officerNameKey"], response["siteCode"])))
            method = "name_site" if officer_key else None
        if not officer_key:
            officer_key = one(by_loose_site.get((response["officerLooseKey"], response["siteCode"])))
            method = "loose_name_site" if officer_key else None
        if not officer_key and response["officerLooseKey"] in alias_map:
            officer_key = alias_map[response["officerLooseKey"]]
            method = "alias"
        if not officer_key:
            officer_key = f"unmapped::{response['officerNameKey']}"
            method = "unmapped"
            officers.setdefault(officer_key, {"officerKey": officer_key, "status": "Unmapped", "officer": response["officer"]})
        resolution_counts[method] += 1
        resolved.append({**response, "officerKey": officer_key, "resolutionMethod": method})
    return resolved, officers, dict(resolution_counts)


def calculate(assignments: list[dict], all_responses: list[dict], officer_dimension: dict[str, dict], snapshot_date: str):
    responses = [r for r in all_responses if r["responseDate"] <= snapshot_date]

    def officer_plan_key(a: dict) -> str:
        return f"{a['status'].lower()}::{a['officerNameKey']}"

    def plan_key(a: dict) -> str:
        return f"{officer_plan_key(a)}|{a['siteCode']}|{a['plannedDate']}"

    def response_plan_key(r: dict) -> str:
        return f"{r['officerKey']}|{r['siteCode']}|{r['responseDate']}"

    plan_keys = {plan_key(a) for a in assignments}
    due = [a for a in assignments if a["plannedDate"] <= snapshot_date]
    response_counts = Counter(response_plan_key(r) for r in responses)
    completed_keys = {plan_key(a) for a in due if response_counts[plan_key(a)] > 0}
    visited_pairs = {(r["officerKey"], r["siteCode"]) for r in responses}

    metrics = {
        key: {
            **officer,
            "totalPlannedFullMonth": 0,
            "totalPlannedTillDate": 0,
            "acceptedResponses": 0,
            "plannedDateResponses": 0,
            "otherUnplannedResponses": 0,
            "distinctPlannedVisitsCompleted": 0,
            "remainingVisits": 0,
            "neverVisitedOutlets": 0,
            "completionPct": None,
        }
        for key, officer in officer_dimension.items()
    }
    for a in assignments:
        metrics[officer_plan_key(a)]["totalPlannedFullMonth"] += 1
    for a in due:
        metrics[officer_plan_key(a)]["totalPlannedTillDate"] += 1
    for r in responses:
        row = metrics[r["officerKey"]]
        row["acceptedResponses"] += 1
        if response_plan_key(r) in plan_keys:
            row["plannedDateResponses"] += 1
    for row in metrics.values():
        row["otherUnplannedResponses"] = row["acceptedResponses"] - row["plannedDateResponses"]
    for a in due:
        if plan_key(a) in completed_keys:
            metrics[officer_plan_key(a)]["distinctPlannedVisitsCompleted"] += 1
    never_by_officer: dict[str, set[str]] = defaultdict(set)
    for a in due:
        ok = officer_plan_key(a)
        if (ok, a["siteCode"]) not in visited_pairs:
            never_by_officer[ok].add(a["siteCode"])
    for ok, row in metrics.items():
        row["remainingVisits"] = row["totalPlannedTillDate"] - row["distinctPlannedVisitsCompleted"]
        row["neverVisitedOutlets"] = len(never_by_officer.get(ok, set()))
        if row["totalPlannedTillDate"]:
            row["completionPct"] = (
                row["distinctPlannedVisitsCompleted"] + row["otherUnplannedResponses"]
            ) / row["totalPlannedTillDate"] * 100

    # Outlet-name lookup is derived from the schedule workbook so response lists can
    # show outlet names without requiring any additional response-workbook headers.
    outlet_name_by_site: dict[str, str] = {}
    for a in assignments:
        if a["siteCode"] and a["outletName"] and a["siteCode"] not in outlet_name_by_site:
            outlet_name_by_site[a["siteCode"]] = a["outletName"]

    details: dict[str, dict] = {}
    for ok in metrics:
        full = [a for a in assignments if officer_plan_key(a) == ok]
        due_officer = [a for a in due if officer_plan_key(a) == ok]
        officer_responses = [r for r in responses if r["officerKey"] == ok]

        planned = [
            {"plannedDate": a["plannedDate"], "siteCode": a["siteCode"], "outletName": a["outletName"]}
            for a in full
        ]
        remaining = [
            {"plannedDate": a["plannedDate"], "siteCode": a["siteCode"], "outletName": a["outletName"]}
            for a in due_officer if plan_key(a) not in completed_keys
        ]
        completed_list = [
            {"plannedDate": a["plannedDate"], "siteCode": a["siteCode"], "outletName": a["outletName"]}
            for a in due_officer if plan_key(a) in completed_keys
        ]
        never_map: dict[str, dict] = {}
        for a in due_officer:
            if (ok, a["siteCode"]) not in visited_pairs:
                never_map.setdefault(a["siteCode"], {"siteCode": a["siteCode"], "outletName": a["outletName"]})

        planned_date_response_list = []
        other_unplanned_response_list = []
        for r in officer_responses:
            item = {
                "responseDate": r["responseDate"],
                "siteCode": r["siteCode"],
                "outletName": outlet_name_by_site.get(r["siteCode"], ""),
                "responseId": r["responseId"],
            }
            if response_plan_key(r) in plan_keys:
                planned_date_response_list.append(item)
            else:
                other_unplanned_response_list.append(item)

        details[ok] = {
            "planned": sorted(planned, key=lambda x: (x["plannedDate"], x["siteCode"])),
            "completed": sorted(completed_list, key=lambda x: (x["plannedDate"], x["siteCode"])),
            "remaining": sorted(remaining, key=lambda x: (x["plannedDate"], x["siteCode"])),
            "neverVisited": sorted(never_map.values(), key=lambda x: x["siteCode"]),
            "plannedDateResponseList": sorted(
                planned_date_response_list,
                key=lambda x: (x["responseDate"], x["siteCode"], x["responseId"])
            ),
            "otherUnplannedResponseList": sorted(
                other_unplanned_response_list,
                key=lambda x: (x["responseDate"], x["siteCode"], x["responseId"])
            ),
        }

    status_order = {"RHO": 0, "Unmapped": 1, "Zonal": 2}
    officers = sorted(metrics.values(), key=lambda r: (status_order.get(r["status"], 9), r["officer"].casefold()))
    return officers, details, responses, due, completed_keys



def attach_last_visits(outlet_directory: dict, responses: list[dict], officer_dimension: dict) -> dict:
    """Adds last-visit dates to every outlet: overall, by its Zonal, and by its RHO.

    Responses are already filtered to the snapshot date by calculate(). A response
    whose site code never appears in the schedule still gets an entry so the outlet
    remains searchable - it simply has no planned officer against it.
    """
    for entry in outlet_directory.values():
        entry.update({
            "lastVisit": None, "lastVisitBy": "",
            "lastVisitZonal": None, "lastVisitZonalBy": "",
            "lastVisitRho": None, "lastVisitRhoBy": "",
        })
    for response in responses:
        site_code = response["siteCode"]
        entry = outlet_directory.get(site_code)
        if entry is None:
            entry = {
                "siteCode": site_code, "outletName": "", "rhoName": "", "zonalName": "",
                "lastVisit": None, "lastVisitBy": "",
                "lastVisitZonal": None, "lastVisitZonalBy": "",
                "lastVisitRho": None, "lastVisitRhoBy": "",
                "unscheduled": True,
            }
            outlet_directory[site_code] = entry
        status = (officer_dimension.get(response["officerKey"]) or {}).get("status", "")
        visit_date = response["responseDate"]
        who = response.get("officer", "")
        if entry["lastVisit"] is None or visit_date > entry["lastVisit"]:
            entry["lastVisit"], entry["lastVisitBy"] = visit_date, who
        if status == "Zonal" and (entry["lastVisitZonal"] is None or visit_date > entry["lastVisitZonal"]):
            entry["lastVisitZonal"], entry["lastVisitZonalBy"] = visit_date, who
        if status == "RHO" and (entry["lastVisitRho"] is None or visit_date > entry["lastVisitRho"]):
            entry["lastVisitRho"], entry["lastVisitRhoBy"] = visit_date, who
    return outlet_directory


def main() -> None:
    cfg = read_json(CONFIG_PATH, {})
    aliases = read_json(ALIAS_PATH, [])
    # Git does not retain empty directories. Recreate data/ so deleting every
    # raw workbook (or even the folder itself) still enters the safe
    # last-successful-snapshot path below.
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    # Raw Excel files are the trigger for a fresh calculation.  Audit answer
    # details are optional for the main visit dashboard but, when present, are
    # published as a compact permanent snapshot for audit.html.
    raw_workbooks = sorted(
        p for p in DATA_DIR.iterdir()
        if p.is_file()
        and not p.name.startswith("~$")
        and p.suffix.lower() in {".xlsx", ".xlsm"}
    )
    audit_snapshot = discover_audit_snapshot(raw_workbooks)

    # A valid Response Summary workbook always starts a refresh.  When the raw
    # schedule workbook is still present it is used directly; otherwise the
    # saved schedule snapshot is reused for the same report month.
    try:
        schedule_path, response_path, superseded_files = discover_inputs()
    except IncompleteInputError as exc:
        preserve_published_snapshots(audit_snapshot, str(exc))
        return

    if schedule_path is not None:
        assignments, outlet_directory = parse_schedule(schedule_path, cfg.get("plannedValues", ["yes"]))
        schedule_file = schedule_path.name
        schedule_source = "raw workbook"
    else:
        try:
            assignments, outlet_directory, schedule_file = load_retained_schedule()
        except IncompleteInputError as exc:
            preserve_published_snapshots(audit_snapshot, str(exc))
            return
        schedule_source = "retained dashboard snapshot"

    parsed_responses, response_diagnostics = parse_responses(response_path, cfg.get("responseAcceptance", {}))
    resolved_responses, officer_dimension, resolution_counts = resolve_responses(parsed_responses, assignments, aliases)
    if not resolved_responses:
        raise RuntimeError("No accepted response rows were found.")
    max_response_date = max(r["responseDate"] for r in resolved_responses)
    first_plan_date = min(a["plannedDate"] for a in assignments)
    if schedule_path is None and max_response_date[:7] != first_plan_date[:7]:
        preserve_published_snapshots(
            audit_snapshot,
            "The new response workbook is for a different month than the retained schedule snapshot.",
        )
        return
    snapshot_date = cfg.get("snapshotDateOverride") or max_response_date
    snapshot_date = parse_date_only(snapshot_date)
    if not snapshot_date:
        raise RuntimeError("Could not determine a valid response snapshot date.")
    officers, details, responses, due, completed_keys = calculate(assignments, resolved_responses, officer_dimension, snapshot_date)
    outlet_directory = attach_last_visits(outlet_directory, responses, officer_dimension)
    report_month = datetime.strptime(first_plan_date, "%Y-%m-%d").strftime("%B %Y")
    unmapped_names = sorted({r["officer"] for r in responses if r["resolutionMethod"] == "unmapped"}, key=str.casefold)
    snapshot_taken_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    output = {
        "metadata": {
            "title": f"{report_month} Visit Compliance Dashboard",
            "subtitle": cfg.get("subtitle", "Officer-wise planned visit and audit-response performance"),
            "surveyReportUrl": cfg.get("surveyReportUrl", ""),
            "surveyReportLabel": cfg.get("surveyReportLabel", "Open survey reports"),
            "surveyReportHint": cfg.get("surveyReportHint", ""),
            "snapshotDate": snapshot_date,
            "reportMonth": report_month,
            "scheduleFile": schedule_file,
            "scheduleSource": schedule_source,
            "responseFile": response_path.name,
            "responseSheet": RESPONSE_SHEET,
            "supersededFiles": superseded_files,
            # Preserve this exact instant with the saved JSON.  The dashboard
            # displays it in the Data Source panel as the last snapshot taken.
            "generatedAt": snapshot_taken_at,
            "snapshotTakenAt": snapshot_taken_at,
            "includeUnmappedInVisibleOfficerKpi": bool(cfg.get("includeUnmappedInVisibleOfficerKpi", False)),
            "diagnostics": {
                "fullMonthAssignments": len(assignments),
                "tillDateAssignments": len(due),
                "acceptedResponses": len(responses),
                **response_diagnostics,
                "resolutionCounts": resolution_counts,
                "unmappedResponseNames": unmapped_names,
            },
        },
        "officers": officers,
        "details": details,
        "outlets": outlet_directory,
        "definitions": {
            "fullMonth": "Total Planned Visits (Full Month) counts every scheduled assignment in the schedule workbook, including dates after the response snapshot.",
            "tillDate": "Total Planned Visits (Till Date) counts scheduled assignments on or before the response snapshot date.",
            "accepted": "Accepted Responses counts unique Response Summary rows through the snapshot that have a response ID, date, site code and Created By User ID.",
            "plannedDate": "Planned-Date Responses counts accepted response rows matching the same officer, outlet code and planned date.",
            "other": "Other / Unplanned Responses are accepted responses that do not match the same officer, outlet code and planned date.",
            "completed": "Distinct Planned Visits Completed counts each due officer/outlet/date assignment once when one or more matching responses exist.",
            "remaining": "Remaining Visits counts due officer/outlet/date assignments with no same-officer, same-outlet, same-date response.",
            "neverVisited": "Never Visited Outlets Till Date counts each outlet code once for the officer when it was due on or before the snapshot and the officer has no response for that outlet on any date through the snapshot. A response on a non-planned date removes the outlet from this count. The summary card, drill-down list and table total show the number of distinct outlet codes never visited across the officers in view, so an outlet shared by a Zonal officer and an RHO is counted once there (the per-officer table column still reports it for each officer).",
            "completion": "Completion % = (Distinct Planned Visits Completed + Other / Unplanned Responses) ÷ Total Planned Visits (Till Date).",
        },
    }

    # A normal rebuild recreates site/. Keep the existing Audit snapshot in
    # memory first when the uploaded files do not include Answer Details.
    previous_audit_assets = saved_audit_assets()
    shutil.rmtree(SITE_DIR, ignore_errors=True)
    shutil.copytree(WEB_DIR, SITE_DIR)
    site_data = SITE_DIR / "data"
    site_data.mkdir(parents=True, exist_ok=True)
    write_json(site_data / "dashboard_data.json", output)
    write_json(site_data / "dashboard_data_last_good.json", output)
    if audit_snapshot is not None:
        write_json(site_data / "audit_data.json", audit_snapshot)
        write_json(site_data / "audit_data_last_good.json", audit_snapshot)
    else:
        restore_audit_assets(previous_audit_assets)
        ensure_last_good_copy(
            site_data / "audit_data.json",
            site_data / "audit_data_last_good.json",
        )
    (SITE_DIR / ".nojekyll").write_text("", encoding="utf-8")

    summary = {
        "snapshotDate": snapshot_date,
        "fullMonthPlans": len(assignments),
        "tillDatePlans": len(due),
        "acceptedResponses": len(responses),
        "completedPlannedVisits": len(completed_keys),
        "remainingVisits": len(due) - len(completed_keys),
        "officerRows": len(officers),
        "unmappedNames": unmapped_names,
    }
    (ROOT / "PREBUILT_SUMMARY.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
