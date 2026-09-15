import io
import os
import re
import sys
import argparse
import logging
from pathlib import Path

import numpy as np
import pandas as pd
import openpyxl

from util.db_io import (
    read_table, read_semester_csvs, write_table, write_full_replace,
    write_partial_replace, upsert_semester_upload, delete_semester_upload,
    count_distinct, count_rows,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

# Sheet code unified college label
SHEET_COLLEGE_MAP = {
    # Engineering & Architecture (CEA and COEA are the same college)
    "CEA":        "CEA",
    "COEA":       "CEA",
    # Technology
    "CTEC":       "CTEC",
    # Computer Studies
    "CCST":       "CCST",
    # Arts & Sciences (DOAS renamed to COAS)
    "COAS":       "COAS",
    "DOAS":       "COAS",
    # Health Sciences (all CAHS sub-units grouped under one label)
    "CNM":        "CAHS",
    "CAHS-SOM":   "CAHS",
    "CAHS-SON":   "CAHS",
    "CAHS-SPHCD": "CAHS",
    # Business & Accountancy (COBA renamed to CBA)
    "COBA":       "CBA",
    "CBA":        "CBA",
}

# ── Dashboard short-code → CSV college labels ─────────────────────────────────
# Used by ml_analysis.py expand_college(). Keep in sync with SHEET_COLLEGE_MAP.
COLLEGE_MAP = {
    "CEA":  ["CEA"],
    "CTEC": ["CTEC"],
    "CCST": ["CCST"],
    "COAS": ["COAS"],
    "CAHS": ["CAHS"],
    "CBA":  ["CBA"],
}

# Semester text patterns inside the sheet header
SEM_PATTERNS = {
    re.compile(r"1st\s+semester", re.I): "1sem",
    re.compile(r"first\s+semester", re.I): "1sem",
    re.compile(r"2nd\s+semester", re.I): "2sem",
    re.compile(r"second\s+semester", re.I): "2sem",
    re.compile(r"summer", re.I): "summer",
}

YEAR_PATTERN = re.compile(r"(\d{4})\s*[-–]\s*(\d{4})")

# Grade special value encoding
GRADE_ENCODING = {
    "DRP":  0.0,   # Dropped
    "NGA":  0.0,   # No Grade (treated as drop)
    "INC":  5.0,   # Incomplete (worst grade bucket)
    "W":    0.0,   # Withdrawn
    "UDR":  0.0,   # Underload (registrar status, not a real grade point —
                    # treated like a drop; seen in COBA/CTEC/CNM sheets)
}

# ── OFFICIAL COLLEGE GRADING SCALE ──────────────────────────────────────────
# The registrar only issues these 11 discrete values — note 3.25/3.50/3.75
# don't exist (3.00 is the last passing grade, 4.00 = conditional, 5.00 =
# failed). Anything that isn't one of these (or the 0.0 drop sentinel) is
# NOT a real grade.
VALID_GRADES = [1.00, 1.25, 1.50, 1.75, 2.00, 2.25, 2.50,
                2.75, 3.00, 4.00, 5.00]

# How far a raw value is allowed to drift from the nearest official grade
# before we treat it as a rounding/entry artifact vs. genuinely corrupted
# data (e.g. a leaked GWA/average cell, or a misaligned column). Real
# rounding noise from Excel float storage is usually < 0.01; this is
# deliberately generous enough to catch "someone typed 1.26 instead of
# 1.25" while still rejecting values like 1.0227 or 0.0714 that are
# nowhere near any real grade point.
MAX_SNAP_DISTANCE = 0.15


# ══════════════════════════════════════════════════════════════════════════════
#  PARSING HELPERS
# ══════════════════════════════════════════════════════════════════════════════

def _snap_numeric_grade(f: float) -> float | None:
    """
    Snap a raw numeric grade to the nearest official grade point (see
    VALID_GRADES / MAX_SNAP_DISTANCE), or return None if it's too far
    from every official grade to plausibly be a real one (e.g. a leaked
    GWA/average cell). Shared by the plain numeric path in parse_grade()
    and the numeric half of combined cells like "INC/2.75".
    """
    # Filter out summary/GWA cells: valid subject grades are 0–5
    if f < 0 or f > 5.0:
        return None

    # 0.0 is the drop/no-grade sentinel, not on the official scale —
    # pass it through unchanged.
    if f == 0.0:
        return 0.0

    nearest = min(VALID_GRADES, key=lambda g: abs(g - f))
    if abs(nearest - f) <= MAX_SNAP_DISTANCE:
        return nearest
    return None


def parse_grade(raw) -> float | None:
    """
    Convert any raw cell value to a float grade or None (skip).

    Handles:
      - Standard numeric grades: 1.0, 1.25 … 3.0, 5.0 — snapped to the
        nearest official grade point (see VALID_GRADES / MAX_SNAP_DISTANCE
        above). Values too far from any real grade point (e.g. 1.0227,
        0.0714 — almost always a leaked GWA/average cell or a misaligned
        column, not a real subject grade) are rejected as None instead of
        being silently accepted, which is what let noisy decimal values
        contaminate Avg_Grade/GWA/Std_Grade for years.
      - Dropped / no-grade: 0, DRP, NGA  → 0.0 (not on the official scale —
        this is a status sentinel, not a real grade point)
      - Incomplete: INC                  → 5.0
      - Combined: INC/2.75, NGA/1.50     → 2.75 / 1.50 (the number wins —
        it's the grade the INC/NGA was later resolved to). Only falls
        back to the prefix's status sentinel (INC→5.0, NGA→0.0, …) when
        whatever follows the slash isn't a usable numeric grade.
      - GWA summary cells (large floats or int > 5) → None
    """
    if raw is None:
        return None

    s = str(raw).strip()
    if s == "" or s.lower() == "none":
        return None

    # Combined cell like "INC/2.75" or "NGA/1.50". The status prefix
    # (INC/NGA/DRP/W) just records what originally happened to the
    # enrollment — if a real grade was later entered after the slash,
    # that's the student's actual final grade and takes priority over
    # the prefix's sentinel value.
    if "/" in s:
        prefix, _, suffix = s.partition("/")
        prefix = prefix.strip().upper()
        suffix = suffix.strip()
        if suffix:
            try:
                numeric = _snap_numeric_grade(float(suffix))
            except ValueError:
                numeric = None
            if numeric is not None:
                return numeric
        # No usable number after the slash — fall back to the prefix's
        # status sentinel (e.g. bare "INC/" or "INC/withdrawn").
        return GRADE_ENCODING.get(prefix, None)

    # Pure keyword
    upper = s.upper()
    if upper in GRADE_ENCODING:
        return GRADE_ENCODING[upper]

    # Numeric
    try:
        f = float(s)
        return _snap_numeric_grade(f)
    except ValueError:
        return None


YEAR_LEVEL_PATTERN = re.compile(r'(\d)\s*(?:st|nd|rd|th)?\s*year', re.I)


def parse_year_level(raw) -> tuple[int | None, str]:
    """
    Normalize the STUDENT YEAR column (col C — e.g. '1st Year', '3rd Year',
    'Irregular', a bare '4', or blank) into (numeric_level, display_label).

    Previously this column was read off the row but never stored anywhere,
    so no downstream dataset or chart could break performance/risk down by
    year level. Returns (None, "Unknown") for anything unrecognized rather
    than guessing, same philosophy as parse_grade()'s MAX_SNAP_DISTANCE
    cutoff — an unparseable value should fall into an explicit "Unknown"
    bucket, not silently become "1st Year".

    'Irregular' is a distinct, explicit category (Year_Level_Num = -1),
    NOT folded into "Unknown" (Year_Level_Num = None -> 0). Registrar
    data uses this label for real students with a non-standard course
    load/schedule — that's meaningfully different from a blank/unparseable
    cell, and collapsing the two would hide a genuine ~5% of the student
    body (577 of 10,632 in the 2024-2 file) behind a catch-all bucket that
    looks like a data-quality gap instead of a real cohort.
    """
    if raw is None:
        return None, "Unknown"
    s = str(raw).strip()
    if not s or s.lower() == "none":
        return None, "Unknown"

    if re.search(r'irreg', s, re.I):
        return -1, "Irregular"

    m = YEAR_LEVEL_PATTERN.search(s)
    if m:
        n = int(m.group(1))
    else:
        try:
            n = int(float(s))
        except ValueError:
            return None, "Unknown"

    if n < 1 or n > 6:
        return None, "Unknown"
    suffix = {1: "st", 2: "nd", 3: "rd"}.get(n, "th")
    return n, f"{n}{suffix} Year"


def is_subject_code(v) -> bool:
    """
    True if the value looks like a subject code (e.g. EGEC0103, MFHC0111-P).
    Subject codes are uppercase letters + digits, 6–14 chars, optional suffix.
    """
    if not isinstance(v, str):
        return False
    return bool(re.match(r'^[A-Z]{2,6}\d{4}', v.strip()))


def is_student_row(row) -> bool:
    """
    True if col 0 is a positive integer (student sequence number).
    """
    v = row[0]
    return isinstance(v, int) and v > 0


def is_course_row(row) -> bool:
    """
    True if col 0 is a non-empty string that looks like a degree name.
    Degree names contain 'bachelor' or 'doctor' or 'master' or start with 'BS'.
    """
    v = row[0]
    if not isinstance(v, str) or len(v.strip()) < 6:
        return False
    low = v.strip().lower()
    return any(kw in low for kw in ("bachelor", "doctor", "master", "diploma"))


def extract_header_info(rows) -> tuple[str, str]:
    """
    Scan the first 20 rows of a sheet for semester and academic year text.
    Returns (semester_str, academic_year_str).
    """
    semester = "1sem"
    academic_year = "Unknown"

    for row in rows[:20]:
        for cell in row:
            if cell is None:
                continue
            text = str(cell)
            for pattern, sem_val in SEM_PATTERNS.items():
                if pattern.search(text):
                    semester = sem_val
            m = YEAR_PATTERN.search(text)
            if m:
                academic_year = f"{m.group(1)}-{m.group(2)}"

    return semester, academic_year


# ══════════════════════════════════════════════════════════════════════════════
#  SHEET PARSER
# ══════════════════════════════════════════════════════════════════════════════

def parse_sheet(ws, college_name: str, semester: str, academic_year: str,
                 stats: dict | None = None) -> list[dict]:
    """
    Parse one sheet and return a list of long-form dicts, one per student×subject.

    `stats`, if given, is a dict keyed by (academic_year, semester) that
    this call accumulates {"total": n, "valid": n} grade-cell counts
    into — every cell paired with a subject code counts toward `total`,
    and every one that parse_grade() successfully resolves to a real
    grade point (not None) counts toward `valid`. This is the raw input
    to the per-upload "Accuracy" figure (valid / total) recorded in
    course_year_level_dropout — see parse_workbook()/process_file().

    Sheet layout (repeating for each course block):
        Row N:   Course name in col 0
        Row N+2: "STUDENT NAME" header
        Row N+4: Subject codes starting at col 3
        Row N+5: Student data row (col 0 = seq#, col 1 = gender, col 3+ = grades)
        (subject row + student row pairs repeat for every student)
    """
    records = []
    rows = list(ws.iter_rows(values_only=True))

    if not rows:
        return records

    # ── Find all course-block start positions ──────────────────────────────
    course_starts: list[tuple[int, str]] = []  # (row_index, course_name)
    for i, row in enumerate(rows):
        if is_course_row(row):
            course_starts.append((i, str(row[0]).strip()))

    if not course_starts:
        log.warning(f"    No course blocks found in sheet {college_name}")
        return records

    # Add sentinel so each block knows where the next starts
    course_starts.append((len(rows), "__END__"))

    # ── Process each course block ──────────────────────────────────────────
    for block_idx in range(len(course_starts) - 1):
        course_row_idx, course_name = course_starts[block_idx]
        next_course_row_idx = course_starts[block_idx + 1][0]

        block_rows = rows[course_row_idx:next_course_row_idx]

        # Within block: subject row (cols 3+) immediately precedes student row
        # We scan pairs: whenever col 0 is int, the row above it is subjects
        prev_subjects: list[str] = []

        for local_i, row in enumerate(block_rows):
            # Check if this is a subject-code row (col 3 onward)
            if row[0] is None and any(is_subject_code(v) for v in row[3:]):
                prev_subjects = [
                    str(v).strip()
                    for v in row[3:]
                    if is_subject_code(v)
                ]
                continue

            if is_student_row(row):
                student_seq = int(row[0])
                gender_raw  = str(row[1]).strip() if row[1] is not None else "Unknown"
                # Text label directly ("Male"/"Female"/"Unknown"), not a 1/0/-1
                # code — this is what lands in csv_file and every downstream
                # table, so SQL/CSV output reads Male/Female, not numbers.
                gender_val  = "Female" if gender_raw.lower() == "female" else (
                              "Male" if gender_raw.lower() == "male" else "Unknown")

                year_level_num, year_level_label = parse_year_level(row[2])

                grades_raw  = row[3:]   # Col C onward

                # Pair each subject code with its grade
                for subj_i, subject_code in enumerate(prev_subjects):
                    raw_grade = grades_raw[subj_i] if subj_i < len(grades_raw) else None
                    grade_val = parse_grade(raw_grade)

                    if stats is not None:
                        key = (academic_year, semester)
                        entry = stats.setdefault(key, {"total": 0, "valid": 0})
                        entry["total"] += 1
                        if grade_val is not None:
                            entry["valid"] += 1

                    if grade_val is None:
                        # Skip cells that are clearly not grades (None, empty, summary)
                        continue

                    # Unique stable student ID: seq#_college_course_sem_year
                    #
                    # IMPORTANT: course_tag must NOT be truncated. Every program
                    # here starts with "Bachelor of Science in ..." /
                    # "Bachelor of Arts in ..." / "Bachelor of Technical-...",
                    # so course_name[:10] always produced the same string
                    # ("Bacheloro") for every single course. That collapsed
                    # different students who happened to share a sequence
                    # number within the same college (e.g. CEA seq #1 in
                    # "Architecture" and CEA seq #1 in "Civil Engineering")
                    # into one Student_ID, silently merging two different
                    # people's grades together in every downstream groupby.
                    # Full sanitized course name = guaranteed unique per course.
                    college_tag = re.sub(r'[^A-Za-z0-9]+', '_', college_name.strip()).strip('_')
                    course_tag  = re.sub(r'[^A-Za-z0-9]+', '_', course_name.strip()).strip('_')
                    student_id  = f"{student_seq}_{college_tag}_{course_tag}_{semester}_{academic_year}"

                    records.append({
                        "Student_ID":     student_id,
                        "Student_Seq":    student_seq,
                        "Gender":         gender_val,
                        "College":        college_name,
                        "Course":         course_name,
                        "Year_Level":     year_level_label,
                        "Year_Level_Num": year_level_num,
                        "Subject":        subject_code,
                        "Grade":          grade_val,
                        "Semester":       semester,
                        "Year":           academic_year,
                    })

                # Reset subjects after consuming (each student has their own subject row)
                prev_subjects = []

    return records


# ══════════════════════════════════════════════════════════════════════════════
#  FILE PARSER
# ══════════════════════════════════════════════════════════════════════════════

# Matches the `userid_timestamp_` prefix that upload_routes._safe_stored_name()
# puts in front of every uploaded file's ON-DISK name, e.g.
# "1_1789446481_2022-1_Student-Performance_Dataset.xlsx". That prefix exists
# for collision-safety and to avoid leaking real server filesystem paths (see
# _safe_stored_name()'s docstring) -- it's intentional, NOT a bug, and the
# actual file on disk should keep it. This regex is only used to strip it
# back off again for LOG readability, so "Parsing: ..." shows a human the
# real filename instead of the userid/timestamp-prefixed one.
_STORED_NAME_PREFIX_RE = re.compile(r"^\d+_\d{9,}_")


def _display_filename(filepath: str) -> str:
    """
    Human-readable version of an uploaded file's path, for logging only.
    Strips the `userid_timestamp_` collision-safety prefix (see
    _STORED_NAME_PREFIX_RE above) if present; falls back to the plain
    basename unchanged for any file that was never through
    _safe_stored_name() (e.g. CLI/manual runs).
    """
    name = os.path.basename(filepath)
    return _STORED_NAME_PREFIX_RE.sub("", name, count=1) or name


def parse_workbook(filepath: str) -> tuple[pd.DataFrame, dict]:
    """
    Parse all sheets of one xlsx file and return (long-form DataFrame,
    stats). `stats` is a dict keyed by (academic_year, semester) with
    {"total": n, "valid": n} grade-cell counts, accumulated across every
    sheet in this file — the input to the per-upload Accuracy figure
    (see parse_sheet()'s docstring / process_file()).
    """
    log.info(f"  Parsing: {_display_filename(filepath)}")
    wb = openpyxl.load_workbook(filepath, read_only=True, data_only=True)

    all_records = []
    stats: dict = {}

    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        rows_preview = list(ws.iter_rows(max_row=20, values_only=True))

        # Map sheet code to full college name
        college_name = SHEET_COLLEGE_MAP.get(
            sheet_name.strip().upper(),
            sheet_name.strip()   # Fallback: use sheet name as-is
        )

        # Extract semester + year from header rows
        semester, academic_year = extract_header_info(rows_preview)

        log.info(f"    Sheet: {sheet_name} → {college_name} | {semester} | {academic_year}")

        records = parse_sheet(ws, college_name, semester, academic_year, stats=stats)
        log.info(f"      → {len(records):,} subject-grade records")
        all_records.extend(records)

    wb.close()
    return pd.DataFrame(all_records), stats


def _accuracy_pct(stats: dict, academic_year: str, semester: str) -> float | None:
    """
    Looks up (academic_year, semester) in a parse_workbook()/merged stats
    dict and returns the validation accuracy as a percentage
    (100 * valid / total grade cells), or None if there's no attempted
    cell to compute a ratio from.
    """
    entry = stats.get((academic_year, semester))
    if not entry or not entry.get("total"):
        return None
    return round(100 * entry["valid"] / entry["total"], 2)


# ══════════════════════════════════════════════════════════════════════════════
#  FEATURE ENGINEERING
# ══════════════════════════════════════════════════════════════════════════════

def engineer_features(df: pd.DataFrame) -> pd.DataFrame:
    """
    From the long-form grade table, compute all per-student aggregates
    used by the ML models.
    """
    # Year numeric (start year of AY, e.g. 2022 from "2022-2023")
    df["Year_Numeric"] = (
        df["Year"].str.extract(r"^(\d{4})")[0].astype(float)
    )

    sem_map = {"1sem": 1, "2sem": 2, "summer": 3}
    df["Sem_Numeric"] = df["Semester"].map(sem_map).fillna(1)

    # Per-student aggregates (groupby student × semester × year)
    key = ["Student_ID", "Student_Seq", "Gender", "College", "Course",
           "Year_Level", "Year_Level_Num",
           "Semester", "Year", "Year_Numeric", "Sem_Numeric"]

    student_agg = (
        df.groupby(key, dropna=False)["Grade"]
        .agg(
            GWA       = lambda g: g[g > 0].mean() if (g > 0).any() else np.nan,
            # Was: Avg_Grade = "mean" — included 0.0 (dropped subjects) as
            # if it were a real grade. On this 1=best/5=worst scale, a
            # dropped subject encoded as 0.0 looks like a BETTER-than-best
            # grade to a naive mean, so every student with a dropped
            # subject had their Avg_Grade artificially pulled down
            # (optimistic) instead of reflecting their actual course
            # performance. GWA already excluded these correctly (g > 0
            # filter below) — Avg_Grade/Std_Grade didn't match that until
            # now, so the two columns disagreed with each other on the
            # exact same underlying grades.
            Avg_Grade = lambda g: g[g > 0].mean() if (g > 0).any() else np.nan,
            Std_Grade = lambda g: g[g > 0].std()  if (g > 0).sum() > 1 else np.nan,
            Sub_Count = "count",
            Min_Grade = "min",
            Max_Grade = "max",
        )
        .reset_index()
    )

    # Flags (per student: did they have any of these in this semester?)
    flag_df = df.groupby("Student_ID").agg(
        is_inc       = ("Grade", lambda g: int((g == 5.0).any())),
        is_drop      = ("Grade", lambda g: int((g == 0.0).any())),
        fail_count   = ("Grade", lambda g: int((g >= 3.0).sum())),
    ).reset_index()

    student_agg = student_agg.merge(flag_df, on="Student_ID", how="left")

    # Derived rate columns
    student_agg["fail_rate"]     = student_agg["fail_count"] / student_agg["Sub_Count"].replace(0, np.nan)
    student_agg["inc_rate"]      = student_agg["is_inc"]  # binary per student
    student_agg["drop_rate"]     = student_agg["is_drop"]
    student_agg["is_irregular"]  = (
        (student_agg["is_inc"] == 1) | (student_agg["is_drop"] == 1)
    ).astype(int)

    return student_agg, df   # return both aggregated and raw long-form


# ══════════════════════════════════════════════════════════════════════════════
#  MODEL DATASET BUILDERS
# ══════════════════════════════════════════════════════════════════════════════

FILENAME_TO_TABLE = {
    "02_dropout_spike_cohort_dropout_trend_chart.csv":              "dropout_spike_cohort",
    "03_dropout_ranking_college_college_ranking_chart.csv":         "dropout_ranking_college",
    "04_gwa_ranking_college_gwa_ranking_chart.csv":                 "gwa_ranking_college",
    "05_gwa_trend_timeseries_gwa_trend_chart.csv":                  "gwa_trend_timeseries",
    "06_inc_forecast_cohort_inc_rate_chart.csv":                    "inc_forecast_cohort",
    "07_irreg_reg_cohort_status_trend_chart.csv":                   "irreg_reg_cohort",
    "08_kpi_gwa_student_kpi_tiles.csv":                             "kpi_gwa_student",
    "09_kpi_enrollment_college_kpi_tiles.csv":                      "kpi_enrollment_college",
    "10_subject_grade_forecast_hardest_subjects_chart.csv":         "subject_grade_forecast",
    "11_performance_band_dist_unused_gwa_distribution_chart.csv":   "performance_band_dist",
    "12_gender_performance_male_retention_trend_chart.csv":         "gender_performance_male",
    "12_gender_performance_female_retention_trend_chart.csv":       "gender_performance_female",
    "13_year_level_performance.csv":                                "year_level_performance",
    "14_year_level_inc_irreg.csv":                                  "year_level_inc_irreg",
    "15_kpi_drop_college_kpi_tiles.csv":                            "kpi_drop_college",
    # (see PARTIAL_REPLACE_KEYS below for how each is written back)
    # "16_course_year_level_dropout.csv" is intentionally NOT mapped here.
    # FIX (2026-09-15, part 4): `course_year_level_dropout` is a CSV-blob
    # table (same shape as semester_uploads: academic_year, semester,
    # student_rows, longform_rows, accuracy, csv_file) -- NOT a normal
    # typed table, so it can't go through save()'s write_full_replace()
    # path below (that expects the DataFrame's own columns to match the
    # table 1:1). It's written explicitly instead, right after this
    # dataset is computed -- see the "16 –" block further down.
}

# Same principle as course_year_level_dropout: instead of TRUNCATEing
# the whole table (write_full_replace), delete+insert only the rows for
# each distinct Year_Numeric[, Sem_Numeric] group present — a new
# upload only touches the group(s) it actually affects, every other
# semester's/year's rows are left alone. Tables aggregated per YEAR
# only (no Sem_Numeric column) use just Year_Numeric as the key.
PARTIAL_REPLACE_KEYS = {
    "dropout_spike_cohort":      ["Year_Numeric"],
    "dropout_ranking_college":   ["Year_Numeric", "Sem_Numeric"],
    "gwa_ranking_college":       ["Year_Numeric", "Sem_Numeric"],
    "gwa_trend_timeseries":      ["Year_Numeric", "Sem_Numeric"],
    "inc_forecast_cohort":       ["Year_Numeric", "Sem_Numeric"],
    "irreg_reg_cohort":          ["Year_Numeric", "Sem_Numeric"],
    "kpi_gwa_student":           ["Year_Numeric", "Sem_Numeric"],
    "kpi_enrollment_college":    ["Year_Numeric", "Sem_Numeric"],
    "subject_grade_forecast":    ["Year_Numeric"],
    "performance_band_dist":     ["Year_Numeric", "Sem_Numeric"],
    "gender_performance_male":   ["Year_Numeric"],
    "gender_performance_female": ["Year_Numeric"],
    "year_level_performance":    ["Year_Numeric", "Sem_Numeric"],
    "year_level_inc_irreg":      ["Year_Numeric", "Sem_Numeric"],
    "kpi_drop_college":          ["Year_Numeric", "Sem_Numeric"],
}


def build_model_datasets(student_df: pd.DataFrame, long_df: pd.DataFrame, out_dir: str = None):
    """Build/refresh all model-dataset tables in MySQL, AND (when `out_dir`
    is given) write each one's plain CSV alongside it in `out_dir`.

    The MySQL table is the source of truth — it's what auto_train.py's
    trainers and the live dashboard should read for analytics/predictions,
    since it's always the freshest, fully-rebuilt copy. The CSV is written
    purely so the 01-16 files keep existing on disk for
    manual inspection/backup, exactly like before the MySQL migration.
    Both are always kept in sync: every call below writes the same
    DataFrame to the table AND (if out_dir is set) to its CSV in the same
    step, so there's no window where one is stale relative to the other.

    Every dataset is rebuilt fully each run — the table is TRUNCATEd and
    re-inserted (write_full_replace(), NOT to_sql(if_exists="replace")),
    so the manually-created schema for each table (see
    create_model_dataset_tables.sql) stays intact across every rebuild
    instead of getting dropped/recreated with pandas' own inferred types.
    The CSV is a plain overwrite, same as before."""

    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    _SEM_NUM_TO_LABEL = {1: "1sem", 2: "2sem", 3: "summer"}

    def _pct_valid(df, cols):
        """Per-dataset validation %: share of this dataset's OWN rows
        where every column in `cols` (the fields that actually matter
        for that chart/table) is non-null. Same idea as
        course_year_level_dropout's own_accuracy below, generalized so
        every one of the 01-17 CSVs gets a real number in its `accuracy`
        column instead of the hardcoded None it had before — that
        column was defined on every model-dataset table (see
        novasight.sql) but never actually populated except for
        semester_uploads and course_year_level_dropout."""
        if df.empty:
            return None
        cols = [c for c in cols if c in df.columns]
        if not cols:
            return None
        return round(100 * df[cols].notna().all(axis=1).mean(), 2)

    def _store_csv_blob(df, table, key_columns, accuracy=None, student_count_col=None):
        """
        Store `df` as CSV-blob row(s) in `table` -- same shape as
        semester_uploads/course_year_level_dropout (academic_year,
        semester, student_rows, longform_rows, accuracy, csv_file).
        `table` (via FILENAME_TO_TABLE) is what identifies whose CSV
        this is; ONE upsert per distinct Year_Numeric[, Sem_Numeric]
        group in `df`, keyed by that group's REAL academic_year/
        semester -- only that group's row is touched, every other
        semester's/year's row is left alone (same principle as the
        "16 –" block below).

        `student_rows`: FIX (2026-09-15, part 6) -- this used to always
        be len(sub), i.e. this dataset's OWN row count (e.g. 6 for a
        chart grouped down to one row per College), which is a
        college/category count, not a student count. When
        `student_count_col` names a column already present in `df`
        that holds a per-row distinct-student count (e.g.
        "Total_Students", "Student_Cnt"), we SUM that column across
        this group instead -- each row's count comes from a mutually
        exclusive slice (a College, a Perf_Band, ...), so the sum is
        the real distinct-student total for this upload. When
        `student_count_col` is omitted, `df` is already one row per
        student (03/04/08's per-student tables), so len(sub) already
        IS the student count and is kept as-is.
        """
    def _store_csv_blob(df, table, key_columns, accuracy=None, student_count_col=None, student_rows_lookup=None):
        """
        ... (see class docstring above for student_count_col) ...
        `student_rows_lookup`: optional Series/dict indexed by this
        group's key_vals, used INSTEAD of summing student_count_col
        when a column-sum would double-count (e.g. dataset 10 groups by
        Subject too, and a student takes several subjects, so summing
        its per-subject Student_Cnt inflates way past the real
        headcount). Falls back to the student_count_col sum, then to
        len(sub), if no match is found.
        """
        for key_vals, sub in df.groupby(key_columns):
            if not isinstance(key_vals, tuple):
                key_vals = (key_vals,)
            yr = int(key_vals[0])
            academic_year = f"{yr}-{yr + 1}"
            semester = (
                _SEM_NUM_TO_LABEL.get(int(key_vals[1]), "1sem")
                if len(key_vals) > 1 else "ALL"  # this table's own grain is per-YEAR only
            )
            lookup_key = key_vals[0] if len(key_vals) == 1 else key_vals
            if student_rows_lookup is not None and lookup_key in student_rows_lookup:
                rows_count = int(student_rows_lookup[lookup_key])
            elif student_count_col and student_count_col in sub.columns:
                rows_count = int(sub[student_count_col].sum())
            else:
                rows_count = len(sub)
            try:
                upsert_semester_upload(
                    table, academic_year, semester,
                    student_rows=rows_count, longform_rows=0,
                    accuracy=accuracy, csv_file=sub.to_csv(index=False),
                )
            except Exception as e:
                log.error(
                    f"  Failed to store {table} CSV for {academic_year} "
                    f"{semester} in MySQL (non-fatal): {e}"
                )

    def save(df, name, accuracy=None, student_count_col=None, student_rows_lookup=None):
        table = FILENAME_TO_TABLE.get(name)
        if table:
            keys = PARTIAL_REPLACE_KEYS.get(table, ["Year_Numeric"])
            _store_csv_blob(df, table, keys, accuracy=accuracy,
                             student_count_col=student_count_col,
                             student_rows_lookup=student_rows_lookup)
        if out_dir:
            csv_path = os.path.join(out_dir, name)
            df.to_csv(csv_path, index=False)
            if table:
                log.info(f"    Saved -> {table} (MySQL) + {csv_path} (CSV): {len(df):,} rows")
            else:
                log.info(f"    Saved -> {csv_path} (CSV only, no table mapping): {len(df):,} rows")
        elif table:
            log.info(f"    Saved -> {table}: {len(df):,} rows")
        else:
            log.info(f"    Skipped {name}: no table mapping and no out_dir")

    # 01 – Dropout risk per student = student_df itself, which IS
    # student_data (already written by write_semester_folder / the
    # migration script) — nothing to do here, kept only as a comment
    # so this function's numbering still lines up with the old CSVs.

    # 02 – Dropout spike cohort (college × year dropout rate)
    spike = (
        student_df.groupby(["Year_Numeric", "College"])
        .agg(
            Total_Students = ("Student_ID", "nunique"),
            Dropout_Count  = ("is_drop", "sum"),
        )
        .reset_index()
    )
    spike["Dropout_Rate"]    = (spike["Dropout_Count"] / spike["Total_Students"] * 100).round(2)
    spike["Non_Dropout_Pct"] = (100 - spike["Dropout_Rate"]).round(2)
    save(spike, "02_dropout_spike_cohort_dropout_trend_chart.csv",
         accuracy=_pct_valid(spike, ["College", "Dropout_Rate"]),
         student_count_col="Total_Students")

    # 03 – Dropout ranking college (student-level with key columns)
    save(
        student_df[["Student_ID", "College", "Course", "Semester",
                    "Sem_Numeric", "Year_Numeric", "GWA", "fail_rate", "is_drop"]],
        "03_dropout_ranking_college_college_ranking_chart.csv",
        accuracy=_pct_valid(student_df, ["College", "Course", "GWA"]),
    )

    # 04 – GWA ranking college (student-level)
    save(
        student_df[["Student_ID", "College", "Course",
                    "Year_Numeric", "Sem_Numeric", "GWA"]].dropna(subset=["GWA"]),
        "04_gwa_ranking_college_gwa_ranking_chart.csv",
        accuracy=_pct_valid(student_df, ["College", "Course", "GWA"]),
    )

    # 05 – GWA trend timeseries (college × year × sem)
    trend = (
        student_df.dropna(subset=["GWA"])
        .groupby(["Year_Numeric", "Sem_Numeric", "College"])
        .agg(
            Avg_GWA     = ("GWA", "mean"),
            Std_GWA     = ("GWA", "std"),
            Student_Cnt = ("Student_ID", "nunique"),
        )
        .reset_index()
    )
    trend["Avg_GWA"] = trend["Avg_GWA"].round(2)
    trend["Std_GWA"] = trend["Std_GWA"].round(2)
    save(trend, "05_gwa_trend_timeseries_gwa_trend_chart.csv",
         accuracy=_pct_valid(trend, ["Avg_GWA", "Std_GWA"]),
         student_count_col="Student_Cnt")

    # 06 – INC forecast cohort
    # FIX (this patch): grouped by College AND Course now — was
    # College-only before, which is why the original inc_forecast
    # trainer/model was abandoned (every course under a college silently
    # reused the same college-wide forecast). A college-level rollup is
    # just this table re-grouped without Course — no separate dataset
    # needed for that case.
    inc = (
        student_df.groupby(["Year_Numeric", "Sem_Numeric", "College", "Course"])
        .agg(
            Total_Students = ("Student_ID", "nunique"),
            INC_Count      = ("is_inc", "sum"),
        )
        .reset_index()
    )
    inc["INC_Rate"] = (inc["INC_Count"] / inc["Total_Students"] * 100).round(2)
    save(inc, "06_inc_forecast_cohort_inc_rate_chart.csv",
         accuracy=_pct_valid(inc, ["College", "Course", "INC_Rate"]),
         student_count_col="Total_Students")

    # 07 – Irreg/Reg cohort
    # FIX (this patch): grouped by College AND Course now (was
    # College-only — see 06's comment above, same root cause). Also
    # renamed off "_unused_legacy" now that get_status_trend's new
    # per-college/per-course Irregular%/INC% models actually consume
    # this table (see train_status_trend in auto_train.py) — it's no
    # longer dead. FILENAME_TO_TABLE below still maps both old and new
    # filenames to the same "irreg_reg_cohort" table, so nothing
    # downstream in db_io.py needs to change.
    irreg = (
        student_df.groupby(["Year_Numeric", "Sem_Numeric", "College", "Course"])
        .agg(
            Total_Students  = ("Student_ID", "nunique"),
            Irregular_Count = ("is_irregular", "sum"),
            Drop_Count      = ("is_drop", "sum"),
            INC_Count       = ("is_inc", "sum"),
        )
        .reset_index()
    )
    irreg["Irregular_Rate"] = (irreg["Irregular_Count"] / irreg["Total_Students"] * 100).round(2)
    irreg["Drop_Rate"]      = (irreg["Drop_Count"]      / irreg["Total_Students"] * 100).round(2)
    irreg["INC_Rate"]       = (irreg["INC_Count"]       / irreg["Total_Students"] * 100).round(2)
    save(irreg, "07_irreg_reg_cohort_status_trend_chart.csv",
         accuracy=_pct_valid(irreg, ["Irregular_Rate", "Drop_Rate", "INC_Rate"]),
         student_count_col="Total_Students")

    # 08 – KPI GWA student (same as 04)
    save(
        student_df[["Student_ID", "College", "Course",
                    "Year_Numeric", "Sem_Numeric", "GWA"]].dropna(subset=["GWA"]),
        "08_kpi_gwa_student_kpi_tiles.csv",
        accuracy=_pct_valid(student_df, ["College", "Course", "GWA"]),
    )

    # 09 – KPI enrollment college
    enroll = (
        student_df.groupby(["Year_Numeric", "Sem_Numeric", "College"])
        .agg(Headcount=("Student_ID", "nunique"))
        .reset_index()
        .sort_values(["College", "Year_Numeric", "Sem_Numeric"])
    )
    enroll["Headcount_Prev"] = enroll.groupby("College")["Headcount"].shift(1)
    enroll["Growth_Rate"] = (
        (enroll["Headcount"] - enroll["Headcount_Prev"])
        / enroll["Headcount_Prev"] * 100
    ).round(2)
    save(enroll, "09_kpi_enrollment_college_kpi_tiles.csv",
         accuracy=_pct_valid(enroll, ["Headcount"]),
         student_count_col="Headcount")

    # 15 – KPI drop college (college × year × sem drop counts) — dedicated
    # dataset for the "Total Drop" KPI tile, mirroring 09's shape so it can
    # get its own model instead of borrowing the dropout-ranking one.
    kpi_drop = (
        student_df.groupby(["Year_Numeric", "Sem_Numeric", "College"])
        .agg(Drop_Count=("is_drop", "sum"),
             Total_Students=("Student_ID", "nunique"))
        .reset_index()
        .sort_values(["College", "Year_Numeric", "Sem_Numeric"])
    )
    save(kpi_drop, "15_kpi_drop_college_kpi_tiles.csv",
         accuracy=_pct_valid(kpi_drop, ["Drop_Count"]),
         student_count_col="Total_Students")

    # 10 – Subject grade forecast (long_df aggregated per subject)
    subj = (
        long_df[long_df["Grade"] > 0]   # exclude drops/INCs for grade difficulty
        .groupby(["Year_Numeric", "College", "Course", "Subject"])
        .agg(
            Avg_Grade   = ("Grade", "mean"),
            Std_Grade   = ("Grade", "std"),
            Student_Cnt = ("Student_ID", "nunique"),
            Fail_Count  = ("Grade", lambda g: (g >= 3.0).sum()),
        )
        .reset_index()
    )
    subj["Avg_Grade"] = subj["Avg_Grade"].round(2)
    subj["Std_Grade"] = subj["Std_Grade"].round(2)
    subj["Fail_Rate"] = (subj["Fail_Count"] / subj["Student_Cnt"] * 100).round(2)
    # A student takes several subjects, so summing this dataset's own
    # per-subject Student_Cnt (student_count_col) would inflate way past
    # the real headcount -- look up the true distinct-student count per
    # Year_Numeric from long_df directly instead.
    subj_student_rows = long_df.dropna(subset=["Year_Numeric"]).groupby("Year_Numeric")["Student_ID"].nunique()
    save(subj, "10_subject_grade_forecast_hardest_subjects_chart.csv",
         accuracy=_pct_valid(subj, ["Avg_Grade", "Fail_Rate"]),
         student_rows_lookup=subj_student_rows)

    # 11 – Performance band distribution
    def perf_band(gwa):
        if pd.isna(gwa): return "Unknown"
        if gwa <= 1.5:   return "Excellent"
        if gwa <= 2.0:   return "Good"
        if gwa <= 2.5:   return "Average"
        if gwa <= 3.0:   return "Below Average"
        return "Failing"

    band_df = student_df.dropna(subset=["GWA"]).copy()
    band_df["Perf_Band"] = band_df["GWA"].apply(perf_band)
    band = (
        band_df.groupby(["Year_Numeric", "Sem_Numeric", "College", "Perf_Band"])
        .agg(Count=("Student_ID", "nunique"))
        .reset_index()
    )
    total_map = (
        band_df.groupby(["Year_Numeric", "Sem_Numeric", "College"])
        ["Student_ID"].nunique()
        .rename("Total")
        .reset_index()
    )
    band = band.merge(total_map, on=["Year_Numeric", "Sem_Numeric", "College"], how="left")
    band["Pct"] = (band["Count"] / band["Total"] * 100).round(2)
    save(band, "11_performance_band_dist_unused_gwa_distribution_chart.csv",
         accuracy=_pct_valid(band, ["Perf_Band", "Count"]),
         student_count_col="Count")

    # 13 – Year-level performance distribution (college × course × year
    # level × perf band). Same bucketing as 11, sliced by Year_Level
    # instead of/alongside College, so charts can show "which cohort
    # (1st/2nd/3rd/4th year) is struggling" instead of only "which college".
    yl_df = band_df.copy()  # already has Perf_Band from the block above
    yl_df["Year_Level"] = yl_df["Year_Level"].fillna("Unknown")
    yl_df["Year_Level_Num"] = yl_df["Year_Level_Num"].fillna(0).astype(int)
    year_level = (
        yl_df.groupby(["Year_Numeric", "Sem_Numeric", "College", "Course",
                        "Year_Level", "Year_Level_Num", "Perf_Band"])
        .agg(Count=("Student_ID", "nunique"))
        .reset_index()
    )
    yl_total = (
        yl_df.groupby(["Year_Numeric", "Sem_Numeric", "College", "Course",
                        "Year_Level", "Year_Level_Num"])
        ["Student_ID"].nunique()
        .rename("Total")
        .reset_index()
    )
    year_level = year_level.merge(
        yl_total,
        on=["Year_Numeric", "Sem_Numeric", "College", "Course",
            "Year_Level", "Year_Level_Num"],
        how="left",
    )
    year_level["Pct"] = (year_level["Count"] / year_level["Total"] * 100).round(2)
    year_level = year_level.sort_values(
        ["College", "Course", "Year_Level_Num"]
    )
    save(year_level, "13_year_level_performance.csv",
         accuracy=_pct_valid(year_level, ["College"]),
         student_count_col="Count")

    # 14 – INC / Irregular(behavioral) / Drop rate by year level
    # Same metrics + idiom as dataset 07 (Irreg/Reg cohort), just sliced
    # by Year_Level (College x Course x Year_Level grain, like 13) instead
    # of College alone. NOTE: "Irregular_Rate" here is the EXISTING
    # behavioral flag (is_irregular = had an INC or dropped a subject
    # this semester) — a different thing from the Year_Level=="Irregular"
    # category itself (the registrar's own course-load classification).
    # Cross-tabulating them is intentional: it shows what fraction of
    # students *labeled* Irregular by the registrar also show up as
    # behaviorally irregular this term, alongside the same question for
    # 1st/2nd/3rd/4th Year students.
    # FIX (2026-09-04): unlike yl_df above, this block used to group the
    # raw student_df directly, without filling NaN Year_Level/Year_Level_Num
    # first. pandas' groupby drops any row whose key is NaN by default, so
    # every student with an unrecognized/not-yet-classified year level
    # (Year_Level_Num == NaN, per the "Irregular=-1, Unknown=None->0"
    # convention above) silently vanished from this dataset — most visible
    # right after a fresh upload, when the newest cohort hasn't been fully
    # registrar-classified yet, which is exactly when "no data" showed up on
    # the INC/Irregular/Drop chart and the dropout heatmap for recent years.
    yl_inc_src = student_df.copy()
    yl_inc_src["Year_Level"] = yl_inc_src["Year_Level"].fillna("Unknown")
    yl_inc_src["Year_Level_Num"] = yl_inc_src["Year_Level_Num"].fillna(0).astype(int)

    yl_inc = (
        yl_inc_src.groupby(["Year_Numeric", "Sem_Numeric", "College", "Course",
                             "Year_Level", "Year_Level_Num"])
        .agg(
            Total_Students  = ("Student_ID", "nunique"),
            Irregular_Count = ("is_irregular", "sum"),
            Drop_Count      = ("is_drop", "sum"),
            INC_Count       = ("is_inc", "sum"),
        )
        .reset_index()
    )
    yl_inc["Irregular_Rate"] = (yl_inc["Irregular_Count"] / yl_inc["Total_Students"] * 100).round(2)
    yl_inc["Drop_Rate"]      = (yl_inc["Drop_Count"]      / yl_inc["Total_Students"] * 100).round(2)
    yl_inc["INC_Rate"]       = (yl_inc["INC_Count"]       / yl_inc["Total_Students"] * 100).round(2)
    yl_inc = yl_inc.sort_values(["College", "Course", "Year_Level_Num"])
    save(yl_inc, "14_year_level_inc_irreg.csv",
         accuracy=_pct_valid(yl_inc, ["College"]),
         student_count_col="Total_Students")

    # 16 – Course x Year-Level dropout heatmap. Split off from 14
    # (2026-09-04) so the heatmap has its own file and its own trainer
    # instead of sharing 14's file and borrowing the Drop_Rate sub-model's
    # eval from train_year_level_inc_irreg. Same source rows, Course grain
    # kept (not collapsed) since the heatmap needs a value per course.
    course_yl_dropout = yl_inc[[
        "Year_Numeric", "Sem_Numeric", "College", "Course",
        "Year_Level", "Year_Level_Num",
        "Total_Students", "Drop_Count", "Drop_Rate",
    ]].copy()
    save(course_yl_dropout, "16_course_year_level_dropout.csv")

    # course_year_level_dropout (MySQL) — written directly here rather
    # than through save()'s FILENAME_TO_TABLE/write_full_replace path,
    # because this table is a CSV-blob table (same shape as
    # semester_uploads: academic_year, semester, student_rows,
    # longform_rows, accuracy, csv_file), not a typed table matching
    # course_yl_dropout's own columns. Reuses upsert_semester_upload()'s
    # existing atomic delete+insert + gzip-compression logic (see
    # db_io.py) instead of duplicating it.
    #
    # CHANGED (2026-09-15): this used to collapse EVERY semester's
    # heatmap rows into ONE blob row under a fixed ("ALL", "ALL")
    # sentinel key, rebuilt from the full cumulative history and
    # overwriting that single row on every upload. That defeated the
    # whole point of this table having its own academic_year/semester
    # columns -- uploading ONE new file silently replaced the combined
    # heatmap for every OTHER semester too, even though nothing about
    # those semesters' own data had changed.
    #
    # Fixed: course_yl_dropout is already grouped by (Year_Numeric,
    # Sem_Numeric) -- it already has a natural per-semester split, we
    # just weren't using it for storage. Now: one upsert PER distinct
    # semester present in the cumulative history, keyed by that
    # semester's REAL academic_year/semester (not a sentinel). Each
    # upsert only deletes+inserts ITS OWN row, so uploading a new file
    # only touches that file's own semester row -- every other
    # semester's row is left completely alone, same as semester_uploads.
    # `accuracy` here is THIS table's own validation, not a copy of
    # semester_uploads' parse-time accuracy: % of that semester's
    # students who had a real Year_Level from the registrar (not the
    # "Unknown"/0 fallback used above so they wouldn't just vanish from
    # the groupby). Measures how complete/trustworthy THIS heatmap's own
    # classification is, since that's what could make a row here wrong
    # even when the underlying grades parsed fine.
    _SEM_NUM_TO_LABEL = {1: "1sem", 2: "2sem", 3: "summer"}

    for (yr_num, sem_num), sub in course_yl_dropout.groupby(["Year_Numeric", "Sem_Numeric"]):
        yr = int(yr_num)
        academic_year = f"{yr}-{yr + 1}"
        semester = _SEM_NUM_TO_LABEL.get(int(sem_num), "1sem")
        sem_mask = (yl_inc_src["Year_Numeric"] == yr_num) & (yl_inc_src["Sem_Numeric"] == sem_num)
        # `student_rows` here means "students in THIS semester" (matches
        # what student_rows means everywhere else in this table's
        # shape), not the heatmap's own row count for this semester.
        sem_student_rows = int(yl_inc_src.loc[sem_mask, "Student_ID"].nunique())
        known_rows = int(student_df.loc[
            (student_df["Year_Numeric"] == yr_num) & (student_df["Sem_Numeric"] == sem_num),
            "Year_Level",
        ].notna().sum())
        total_rows = int(sem_mask.sum())
        own_accuracy = round(100 * known_rows / total_rows, 2) if total_rows else None
        try:
            upsert_semester_upload(
                "course_year_level_dropout", academic_year, semester,
                student_rows=sem_student_rows, longform_rows=0,
                accuracy=own_accuracy,
                csv_file=sub.to_csv(index=False),
            )
        except Exception as e:
            log.error(
                f"  Failed to store course_year_level_dropout CSV for "
                f"{academic_year} {semester} in MySQL (non-fatal): {e}"
            )

    # 12 – Gender performance
    gender = (
        student_df.groupby(["Year_Numeric", "College", "Gender"])
        .agg(
            Student_Count  = ("Student_ID", "nunique"),
            Dropout_Rate   = ("is_drop", lambda g: g.mean() * 100),
            INC_Rate       = ("is_inc",  lambda g: g.mean() * 100),
        )
        .reset_index()
    )
    gender["Dropout_Rate"]   = gender["Dropout_Rate"].round(2)
    gender["INC_Rate"]       = gender["INC_Rate"].round(2)
    # Gender is already the text label ("Male"/"Female"/"Unknown") coming
    # out of parse_sheet() now, so no numeric→label mapping needed here.
    gender["Gender_Label"]   = gender["Gender"]

    # Split into a Male-only and a Female-only CSV instead of one combined
    # file with a Gender_Label dummy column. Two reasons:
    #   1. train_gender_performance previously fit ONE model across both
    #      genders with Gender as a one-hot feature — on a small cohort-
    #      level dataset like this, that lets the model partly average
    #      away gender-specific signal instead of learning each gender's
    #      own trend. Two dedicated models (one per gender) can each fit
    #      that gender's Dropout_Rate/INC_Rate pattern directly.
    #   2. It matches how these numbers are actually consumed downstream
    #      (a Male line and a Female line, never a blended one), so the
    #      training data now mirrors the shape of the eventual forecast.
    # "Unknown" gender rows are dropped from both — not enough of them to
    # train a third model on, and the two retention cards only ever show
    # Male vs Female.
    gender_male   = gender[gender["Gender_Label"] == "Male"].drop(columns=["Gender", "Gender_Label"]).reset_index(drop=True)
    gender_female = gender[gender["Gender_Label"] == "Female"].drop(columns=["Gender", "Gender_Label"]).reset_index(drop=True)
    save(gender_male,   "12_gender_performance_male_retention_trend_chart.csv",
         accuracy=_pct_valid(gender_male, ["Dropout_Rate", "INC_Rate"]),
         student_count_col="Student_Count")
    save(gender_female, "12_gender_performance_female_retention_trend_chart.csv",
         accuracy=_pct_valid(gender_female, ["Dropout_Rate", "INC_Rate"]),
         student_count_col="Student_Count")


# ══════════════════════════════════════════════════════════════════════════════
#  MAIN ENTRY POINT
# ══════════════════════════════════════════════════════════════════════════════

def run_preprocessing(
    input_dir:  str,
    output_dir: str,
    model_datasets_dir: str | None = None,
) -> dict:
    """
    Main preprocessing pipeline.  Called by upload_routes.py after a file is
    saved to disk, OR run standalone via CLI.

    Parameters
    ----------
    input_dir           Folder containing all uploaded .xlsx files
    output_dir          Where to write Final_Merged_Student_Data.csv + long-form CSV
    model_datasets_dir  Where to write the 12 model-dataset CSVs
                        (defaults to output_dir/model_datasets)

    Returns
    -------
    dict with keys: success, student_rows, subject_rows, files_processed, error
    """
    if model_datasets_dir is None:
        model_datasets_dir = os.path.join(output_dir, "model_datasets")

    os.makedirs(output_dir, exist_ok=True)
    os.makedirs(model_datasets_dir, exist_ok=True)

    xlsx_files = sorted(Path(input_dir).glob("*.xlsx"))
    if not xlsx_files:
        return {"success": False, "error": "No .xlsx files found in input directory"}

    log.info(f"Found {len(xlsx_files)} xlsx files in {input_dir}")

    all_long_dfs = []
    merged_stats: dict = {}

    for fpath in xlsx_files:
        try:
            df, stats = parse_workbook(str(fpath))
            if not df.empty:
                all_long_dfs.append(df)
            for key, entry in stats.items():
                merged = merged_stats.setdefault(key, {"total": 0, "valid": 0})
                merged["total"] += entry["total"]
                merged["valid"] += entry["valid"]
        except Exception as e:
            log.error(f"  Failed to parse {fpath.name}: {e}")
            continue

    if not all_long_dfs:
        return {"success": False, "error": "All files failed to parse"}

    # Concatenate ALL long-form records
    long_df = pd.concat(all_long_dfs, ignore_index=True)
    log.info(f"Total long-form records: {len(long_df):,}")
    log.info(f"Unique students:         {long_df['Student_ID'].nunique():,}")
    log.info(f"Unique subjects:         {long_df['Subject'].nunique():,}")

    # Feature engineering → student-level aggregates. Do this BEFORE
    # writing longform_grades: engineer_features() is what adds
    # Year_Numeric (a real column on the table) to long_df.
    student_df, long_df = engineer_features(long_df)
    log.info(f"Student-level rows: {len(student_df):,}")

    # Save the raw long-form (subject-level) master data to
    # Final_LongForm_Student_Grades.csv (kept on disk for backup/
    # inspection) and split the combined frame back into per-semester
    # groups, writing each one via write_semester_folder() — the disk
    # folder under by_year/ is the source of truth; MySQL only gets each
    # semester's row counts (semester_uploads), same as process_file()'s
    # single-upload path.
    long_csv_path = os.path.join(output_dir, "Final_LongForm_Student_Grades.csv")
    long_df.to_csv(long_csv_path, index=False)
    log.info(f"Saved long-form data -> {long_csv_path}")

    # Save the student-level master data to Final_Merged_Student_Data.csv
    # (kept on disk for backup/inspection).
    student_csv_path = os.path.join(output_dir, "Final_Merged_Student_Data.csv")
    student_df.to_csv(student_csv_path, index=False)
    log.info(f"Saved student data -> {student_csv_path}")

    by_year_dir = os.path.join(output_dir, "by_year")
    for (ay, sem), s_slice in student_df.groupby(["Year", "Semester"], dropna=True):
        l_slice = long_df[(long_df["Year"] == ay) & (long_df["Semester"] == sem)]
        accuracy = _accuracy_pct(merged_stats, ay, sem)
        write_semester_folder(s_slice, l_slice, by_year_dir, ay, sem, accuracy=accuracy)


    # Build and save all 12 model datasets
    log.info("Building model datasets...")
    build_model_datasets(student_df, long_df, model_datasets_dir)

    return {
        "success":         True,
        "student_rows":    len(student_df),
        "subject_rows":    len(long_df),
        "files_processed": len(xlsx_files),
        "error":           None,
    }


# ══════════════════════════════════════════════════════════════════════════════
#  COMPATIBILITY SHIM FOR auto_train.py
#  ─────────────────────────────────────────────────────────────────────────────
#  auto_train.py imports these five names from this module:
#
#    from preprocessing.preprocess import (
#        process_file, export_model_datasets,
#        FINAL_COLUMNS, PROCESSED_DIR, MODEL_DATA_DIR, FINAL_OUTPUT,
#    )
#
#  They map to the new API as follows:
# ══════════════════════════════════════════════════════════════════════════════

try:
    from configs.config import (
        PROCESSED_DATASETS_DIR  as _PROCESSED_DIR,
        MODEL_DATASETS_DIR      as _MODEL_DATA_DIR,
        FINAL_MERGED_CSV        as _FINAL_OUTPUT,
        UNPROCESSED_DATASETS_DIR as _UNPROCESSED_DIR,
        PROCESSED_BY_YEAR_DIR   as _BY_YEAR_DIR,
    )
except ImportError:
    # Fallback for standalone / CLI use outside the Flask app
    _PROCESSED_DIR   = os.path.join(os.path.dirname(__file__), "..", "Processed_Datasets")
    _MODEL_DATA_DIR  = os.path.join(_PROCESSED_DIR, "model_datasets")
    _FINAL_OUTPUT    = os.path.join(_PROCESSED_DIR, "Final_Merged_Student_Data.csv")
    _UNPROCESSED_DIR = os.path.join(os.path.dirname(__file__), "..", "Unprocessed_Datasets")
    _BY_YEAR_DIR     = os.path.join(_PROCESSED_DIR, "by_year")

# ── Constants ─────────────────────────────────────────────────────────────────
PROCESSED_DIR   = _PROCESSED_DIR
MODEL_DATA_DIR  = _MODEL_DATA_DIR
FINAL_OUTPUT    = _FINAL_OUTPUT
BY_YEAR_DIR     = _BY_YEAR_DIR  

# Columns that auto_train.py keeps when it de-dupes the master CSV.
# Must match the student-level CSV produced by engineer_features().
FINAL_COLUMNS = [
    "Student_ID", "Student_Seq", "Gender", "College", "Course",
    "Year_Level", "Year_Level_Num",
    "Semester", "Year", "Year_Numeric", "Sem_Numeric",
    "GWA", "Avg_Grade", "Std_Grade", "Sub_Count",
    "Min_Grade", "Max_Grade",
    "is_inc", "is_drop", "fail_count", "fail_rate",
    "inc_rate", "drop_rate", "is_irregular",
]


# ══════════════════════════════════════════════════════════════════════════════
#  PER-SEMESTER STORAGE (no combining, ever, on disk)
#  ─────────────────────────────────────────────────────────────────────────────
#  Every upload gets its OWN folder under BY_YEAR_DIR, keyed by academic
#  year + semester — e.g. BY_YEAR_DIR/2022-2023_1sem/{Student_Data,
#  LongForm_Grades}.csv — holding ONLY that one file's rows. Uploading a
#  new semester NEVER reads, appends to, or merges with any other
#  semester's folder, including a different semester of the SAME year.
#  Two semesters of the same year sit in two completely separate folders.
#  The only place separate semesters are ever combined is in memory, at
#  train time, by load_all_semesters() — nothing on disk is ever rewritten
#  as a combined/merged file except the derived master CSV/model_datasets,
#  which are fully regenerated (not appended to) each time training runs.
# ══════════════════════════════════════════════════════════════════════════════

def _semester_dir_name(academic_year: str, semester: str) -> str:
    return f"{academic_year}_{semester}"


def write_semester_folder(student_df: pd.DataFrame, long_df: pd.DataFrame,
                           by_year_dir: str, academic_year: str, semester: str,
                           accuracy: float | None = None) -> str:
    """
    Records this semester's upload as a single row in MySQL's
    semester_uploads table via upsert_semester_upload() — row
    counts, an optional validation Accuracy percentage, and the actual
    STUDENT-LEVEL data as CSV text in the `csv_file` column (same shape
    as dataset 01, "01_dropout_risk_per_student_dropout_pie_status_pie.csv"
    from build_model_datasets() — i.e. student_df.to_csv()).

    CHANGED (2026-09-15): this used to write Student_Data.csv +
    LongForm_Grades.csv to by_year_dir/<academic_year>_<semester>/ on
    disk, with the disk folder as the source of truth and MySQL holding
    only row-count metadata (no CSV blob). That disk write is REMOVED —
    `by_year_dir` is kept as a parameter only for call-site
    compatibility and is no longer touched.

    `long_df` itself is no longer persisted anywhere by this function —
    only its row count goes into `longform_rows`, same as before.

    `accuracy` is the % of grade cells in this upload that parse_grade()
    successfully resolved to a real grade point, out of every cell
    paired with a subject code (see parse_sheet()'s `stats` param) — a
    rough measure of how cleanly this particular file parsed. Pass None
    when it isn't known (e.g. a caller that doesn't have parse stats).

    upsert_semester_upload() deletes-then-inserts on (academic_year,
    semester), so a re-upload of the same semester just overwrites that
    one row (a re-upload replaces that one semester's csv_file, it
    doesn't get combined with the old copy).

    ⚠ Anything that previously read by_year/<academic_year>_<semester>/
    directly off disk (e.g. a load_all_semesters()-style training
    loader, or auto_train.run_full_pipeline()'s MIN_YEARS_FOR_TRAINING
    gate) will need to be repointed at this table/column instead, since
    that folder is no longer populated here.

    FIX (2026-09-15, part 5): `long_df` IS now also persisted — as its
    own CSV blob in a separate `longform_uploads` table (same
    (academic_year, semester, ..., csv_file) shape as semester_uploads,
    auto-created on first write same as every other CSV-blob table
    here). Before this fix, long_df's row count went into
    `longform_rows` but the actual subject-level rows were never
    written anywhere, so load_all_semesters() could only ever return an
    empty long_df — which silently zeroed out dataset 10
    (subject_grade_forecast) on every rebuild after the first upload.
    """
    csv_file = student_df.to_csv(index=False)

    upsert_semester_upload("semester_uploads", academic_year, semester,
                            student_rows=len(student_df), longform_rows=len(long_df),
                            accuracy=accuracy, csv_file=csv_file)

    try:
        upsert_semester_upload("longform_uploads", academic_year, semester,
                                student_rows=len(student_df), longform_rows=len(long_df),
                                accuracy=accuracy, csv_file=long_df.to_csv(index=False))
    except Exception as e:
        # Never let a longform-storage hiccup fail the student-level
        # upload above — worst case dataset 10 stays stale/empty for
        # this semester, everything else (already written) is fine.
        log.error(f"  Failed to store longform_uploads CSV for {academic_year} {semester} (non-fatal): {e}")

    acc_log = f", accuracy {accuracy}%" if accuracy is not None else ""
    log.info(
        f"  Semester recorded: {academic_year} {semester} -> "
        f"{len(student_df):,} student rows, {len(long_df):,} long-form rows{acc_log} "
        f"(csv_file: {len(csv_file):,} chars)"
    )
    return f"{academic_year}_{semester}"


def count_years_with_data(by_year_dir: str) -> int:
    """
    Distinct ACADEMIC YEARS represented across all semester folders under
    by_year_dir (a year counts as soon as any one of its semesters has
    been uploaded). This is the MIN_YEARS_FOR_TRAINING gate
    auto_train.py checks before it will (re)build the master CSV /
    model_datasets and train — e.g. 3 years (6 semesters, at 2 per year)
    before the first training run.
    """
    # `by_year_dir` param kept for call-site compatibility but unused now.
    # semester_uploads has one row per (academic_year, semester) upload —
    # COUNT(DISTINCT academic_year) is exactly this, no filesystem scan.
    return count_distinct("semester_uploads", "academic_year")


def count_semesters_with_data(by_year_dir: str) -> int:
    """Total number of individual semester uploads with data — the raw
    upload count, as opposed to count_years_with_data()'s distinct-year
    count. Handy for surfacing '4/6 semesters uploaded' style progress."""
    # `by_year_dir` param kept for call-site compatibility but unused now.
    # One row per (academic_year, semester) in semester_uploads, so
    # COUNT(*) is exactly this.
    return count_rows("semester_uploads")


def load_all_semesters(by_year_dir: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    """
    Rebuilds the combined student-level DataFrame across every uploaded
    semester by reading the `csv_file` column back out of MySQL's
    semester_uploads table (one row per (academic_year,
    semester) upload) and concatenating them.

    CHANGED (2026-09-15): this used to read
    by_year_dir/<academic_year>_<semester>/Student_Data.csv +
    LongForm_Grades.csv off disk — write_semester_folder() no longer
    writes either file (see its docstring), so reading disk here always
    came back empty and made every upload past MIN_YEARS_FOR_TRAINING
    fail with "No data in by_year/ folders." `by_year_dir` is kept as a
    parameter only for call-site compatibility and is no longer touched.

    FIX (2026-09-15, part 5): long-form (subject-level) rows are now
    read back from their own `longform_uploads` table (written by
    write_semester_folder() — see its docstring) instead of always
    being returned empty. Before this fix, dataset 10
    ("10_subject_grade_forecast_hardest_subjects_chart.csv") — and
    anything trained off it — always got 0 rows here even though the
    source .xlsx parsed subject-level data just fine, because nothing
    downstream of the initial upload ever stored it anywhere.
    """
    # read_semester_csvs() (not read_table()) — csv_file is stored
    # gzip+base64 compressed since 2026-09-15 (see db_io.py), so this
    # decompresses each row back into plain CSV text before we parse it.
    rows = read_semester_csvs("semester_uploads")

    student_frames = []
    if not rows.empty and "csv_file" in rows.columns:
        for csv_text in rows["csv_file"].dropna():
            try:
                student_frames.append(pd.read_csv(io.StringIO(csv_text)))
            except Exception as e:
                log.error(f"  Failed to parse a stored csv_file blob: {e}")

    student_df = pd.concat(student_frames, ignore_index=True) if student_frames else pd.DataFrame()
    if student_df.empty:
        student_df = pd.DataFrame(columns=FINAL_COLUMNS)

    long_rows = read_semester_csvs("longform_uploads")
    long_frames = []
    if not long_rows.empty and "csv_file" in long_rows.columns:
        for csv_text in long_rows["csv_file"].dropna():
            try:
                long_frames.append(pd.read_csv(io.StringIO(csv_text)))
            except Exception as e:
                log.error(f"  Failed to parse a stored longform csv_file blob: {e}")

    long_df = (
        pd.concat(long_frames, ignore_index=True) if long_frames else
        pd.DataFrame(columns=["Student_ID", "College", "Course", "Subject", "Grade", "Year_Numeric"])
    )
    return student_df, long_df


def process_file(xlsx_path: str) -> pd.DataFrame:
    """
    Compatibility wrapper called by auto_train.run_full_pipeline(new_file=...).

    Parses a single .xlsx file and writes the result into ONLY that file's
    own standalone semester folder under BY_YEAR_DIR (see
    write_semester_folder) — it does NOT touch any shared/master CSV and
    does NOT read or merge with any other semester's or year's data, not
    even a different semester of the same academic year. The caller
    (auto_train) decides separately whether enough years now exist to
    rebuild the shared master CSV / model_datasets and (re)train — see
    load_all_semesters() / count_years_with_data().

    Returns the student-level DataFrame for THIS FILE ONLY (all
    FINAL_COLUMNS populated), so the caller can log/report on it.
    """
    log.info(f"process_file: {_display_filename(xlsx_path)}")

    long_df, parse_stats = parse_workbook(xlsx_path)
    if long_df.empty:
        log.warning("process_file: no records extracted — returning empty DataFrame")
        return pd.DataFrame(columns=FINAL_COLUMNS)

    student_df, long_df = engineer_features(long_df)

    # Ensure all FINAL_COLUMNS exist (fill missing with sensible defaults)
    for col in FINAL_COLUMNS:
        if col not in student_df.columns:
            student_df[col] = np.nan
    student_df = student_df[FINAL_COLUMNS]

    # ── Persist into this file's own standalone semester folder(s) ─────
    # Normally a grade sheet covers exactly one academic year + semester;
    # guard against a stray multi-year/multi-sem file by splitting per
    # (year, semester) pair so a folder never receives another upload's
    # rows.
    combos = (
        student_df[["Year", "Semester"]]
        .dropna()
        .drop_duplicates()
        .itertuples(index=False, name=None)
    )
    combos = list(combos)
    if len(combos) > 1:
        log.warning(f"  File spans multiple year/semester combos {combos} — splitting per folder")
    elif not combos:
        log.warning("  File has no parseable academic year/semester — nothing written to disk")

    for ay, sem in combos:
        s_slice = student_df[(student_df["Year"] == ay) & (student_df["Semester"] == sem)].copy()
        l_slice = long_df[(long_df["Year"] == ay) & (long_df["Semester"] == sem)].copy()
        accuracy = _accuracy_pct(parse_stats, ay, sem)
        write_semester_folder(s_slice, l_slice, BY_YEAR_DIR, ay, sem, accuracy=accuracy)

    # ── Refresh the 01-16 model-dataset tables on EVERY upload ─────────
    # FIX (2026-09-15): these tables used to only get (re)built inside
    # auto_train.run_full_pipeline()'s full training pass, which is gated
    # behind MIN_YEARS_FOR_TRAINING (currently 3 years). That's fine for
    # the actual trained models/.pkl files, but several of these tables
    # (subject_grade_forecast, year_level_performance, year_level_inc_irreg,
    # semester_uploads, etc.) also back plain historical charts in
    # ml_analysis.py that have nothing to do with prediction — those charts
    # were showing 0 rows for any deployment with fewer than 3 years of data,
    # even though the by_year/ disk data (used for the KPI/GWA charts) was
    # already fully populated from every single upload.
    #
    # Rebuilding here mirrors how write_semester_folder() above already
    # writes this upload's folder to by_year/ on every upload: pull the
    # FULL cumulative history back off disk (this upload's rows included,
    # since they were just written above) and rebuild all 16 tables from
    # that. This is pure pandas aggregation (no model fitting), so it's
    # cheap enough to run on every upload rather than waiting for the
    # training gate. run_full_pipeline()'s own call into
    # build_model_datasets() after a successful training pass just
    # rebuilds these same tables again from the same full history — safe,
    # idempotent, no double-counting.
    if combos:
        try:
            all_student_df, all_long_df = load_all_semesters(BY_YEAR_DIR)
            # FIX: this used to pass MODEL_DATA_DIR as out_dir, so EVERY
            # upload also wrote all 17 CSVs to disk (Processed_Datasets/
            # model_datasets/) — a local folder your VS Code workspace
            # picked up, even though MySQL is the actual source of truth
            # now. out_dir=None means build_model_datasets() only writes
            # to MySQL (see save()'s `if out_dir:` guard below), nothing
            # touches the filesystem on a normal web upload anymore.
            build_model_datasets(all_student_df, all_long_df, out_dir=None)
        except Exception as e:
            # Never let a chart-table refresh failure fail the upload
            # itself — this upload's by_year/ folder is already safely
            # written by this point.
            log.error(f"  build_model_datasets refresh failed (non-fatal): {e}")

    return student_df


def export_model_datasets(merged_df: pd.DataFrame, out_dir: str, long_df: pd.DataFrame | None = None):
    """
    Compatibility wrapper called by auto_train after it rebuilds the master
    CSV from all semester folders (see load_all_semesters()).

    CHANGED (2026-09-15): `out_dir` is now IGNORED — data now lives fully
    in MySQL (moved off XAMPP's filesystem storage). No CSV files or
    folders (model_datasets/, etc.) are written to disk anymore, even
    during a full training pass — this matches process_file()'s regular
    upload path, which has been MySQL-only (out_dir=None) since the
    2026-09-15 migration. `out_dir` is kept as a parameter only so
    auto_train.py's existing call site doesn't need to change.

    `long_df` should normally be passed in by the caller (it already has it
    from load_all_semesters() and re-reading would be redundant); if
    omitted, it's rebuilt here from MySQL via load_all_semesters().
    """
    log.info("export_model_datasets → MySQL only (disk CSV export disabled)")

    if long_df is None:
        _, long_df = load_all_semesters(BY_YEAR_DIR)

    build_model_datasets(merged_df, long_df, out_dir=None)


# ── CLI ───────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="NovaSight Grade Preprocessor v2")
    parser.add_argument("--input_dir",  default="Unprocessed_Datasets",
                        help="Folder with .xlsx grade sheets")
    parser.add_argument("--output_dir", default="Processed_Datasets",
                        help="Output folder for CSVs")
    parser.add_argument("--model_dir",  default=None,
                        help="Output folder for model datasets (default: output_dir/model_datasets)")
    args = parser.parse_args()

    result = run_preprocessing(args.input_dir, args.output_dir, args.model_dir)

    if result["success"]:
        print("\nPreprocessing complete!")
        print(f"   Files processed : {result['files_processed']}")
        print(f"   Students        : {result['student_rows']:,}")
        print(f"   Subject records : {result['subject_rows']:,}")
    else:
        print(f"\nPreprocessing failed: {result['error']}")
        sys.exit(1)