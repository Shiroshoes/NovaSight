"""
preprocess.py  —  NovaSight web-app preprocessing (synced with preprocess_v2.py)
================================================================================
The parsing / validation / warning / catalog-check logic of preprocess_v2.py
now lives here, behind the SAME public functions the rest of the web app
already calls (parse_workbook, parse_workbook_v2, process_file,
process_file_v2, run_preprocessing, engineer_features,
build_model_datasets, write_semester_folder, load_all_semesters, ...).

What changed vs. the old parser
  * Wide/matrix layout: a code row above every student row, grades aligned
    column-for-column (cols D..P), reported totals in cols Q..T.
  * Grade rules from v2: blank / 0 / "-" -> DRP, 5.00 -> FAILED, CRD kept
    literal, slash cells ("INC/2.75") resolved, out-of-range rejected,
    GWA-like precision flagged instead of silently snapped.
  * Typo / .upper() normalization for Gender, College, Course, Year Level,
    Semester and Academic Year (difflib), with warnings.
  * Duplicate Seq detection + sequential re-numbering per course.
  * Optional course-catalog cross-check (course_catalog_checker.py):
    subject titles, credit units, Credits_Earned, credit-weighted GWA.
  * Warnings come from warnings_core.WarningCollector, are aggregated per
    (category, sheet) and tiered null / highlight / plain.

What did NOT change: the long-form schema handed to engineer_features()
and stored in the DB (Student_Seq, Subject, "1sem"/"2sem", "Male"/"Female",
Grade 0.0 = dropped, 5.0 = INC/failed, ...). v2's richer output is
translated to it in _wide_to_legacy_long() so every dataset builder,
chart and model downstream keeps working untouched.

Needs, next to this file (or on sys.path):
    warnings_core.py, course_catalog_checker.py
Optional catalog file: set COURSE_CATALOG_PATH in configs.config, or the
NOVASIGHT_CATALOG_PATH environment variable.
"""

from __future__ import annotations

import io
import os
import re
import sys
import argparse
import difflib
import logging
import hashlib
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import pandas as pd
import openpyxl
from openpyxl import load_workbook

# course_catalog_checker.py does `from warnings_core import ...` as a
# top-level import, so the folder holding this file must be importable.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from util.db_io import (
    read_table, read_semester_csvs, write_table, write_full_replace,
    write_partial_replace, upsert_semester_upload, delete_semester_upload,
    count_distinct, count_rows,
    # New: warning storage + duplicate detection
    save_preprocessing_warnings, compute_file_hash, check_file_hash,
)

from warnings_core import WarningCollector, NULL_WARNING_CATEGORIES, HIGHLIGHT_CATEGORIES
import course_catalog_checker

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

# Warning tier constants — used by save_preprocessing_warnings()
TIER_NULL      = "null"       # 🔴 Required field empty/missing
TIER_HIGHLIGHT = "highlight"  # 🟡 Value outside every known rule (never auto-deleted)
TIER_PLAIN     = "resolved"   # ✅ Auto-corrections, resolved values, handled cases

# Categories that map to each tier. warnings_core.py is the single source of
# truth (this module used to keep a hand-copied "mirror" of these sets).
_NULL_CATEGORIES      = set(NULL_WARNING_CATEGORIES)
_HIGHLIGHT_CATEGORIES = set(HIGHLIGHT_CATEGORIES)

def _tier_for_category(category: str) -> str:
    if category in _NULL_CATEGORIES:      return TIER_NULL
    if category in _HIGHLIGHT_CATEGORIES: return TIER_HIGHLIGHT
    return TIER_PLAIN  # resolved


def _fmt_seqs(items) -> str:
    """
    Formats the students hit by a warning for appending to its message,
    e.g. "(Seq# / Course: 12 - BS in Architecture, 45 - BS in Nursing)".
    `items` is an iterable of (seq, course) pairs. Caps the visible list
    at 20 so one warning message can't blow up on a college with hundreds
    of hits — the rest are summarized as "+N more".
    """
    pairs = sorted(
        {(int(s), str(c) if c is not None else "?") for s, c in items if s is not None},
        key=lambda p: p[0],
    )
    if not pairs:
        return ""
    shown = pairs[:20]
    tail = f", +{len(pairs) - 20} more" if len(pairs) > 20 else ""
    formatted = ", ".join(f"{s} - {c}" for s, c in shown)
    return f" (Seq# / Course: {formatted}{tail})"

# ══════════════════════════════════════════════════════════════════════════════
#  WEB-APP SWITCHES
# ══════════════════════════════════════════════════════════════════════════════

# process_file_v2() (the upload-route entry point) rejects a file whose name
# isn't "YYYY-S Student-Performance Dataset.xlsx" — the `userid_timestamp_`
# prefix added by upload_routes._safe_stored_name() is stripped first. Set to
# False to accept any name (the year/semester are then read from the sheet
# headers, like the old parser did). process_file() / run_preprocessing()
# never reject on filename.
ENFORCE_FILENAME_FORMAT = True

# v2 rule: a student whose record is unreliable (Subject Count mismatch,
# >13 or 0 subjects, ...) is held back from the training dataset. The stored
# long-form table has no Include_In_Training column, so "held back" means
# "not written to the DB / model datasets" here. Set to False to keep them.
HOLD_BACK_EXCLUDED_STUDENTS = True

# Course catalog (Course_Code | Course_Title | Credit_Units) used by
# course_catalog_checker. Optional — without it the catalog cross-check and
# credit-weighted GWA are skipped (GWA falls back to col T / plain average).
try:
    from configs.config import COURSE_CATALOG_PATH as _CFG_CATALOG_PATH
except ImportError:
    _CFG_CATALOG_PATH = None
COURSE_CATALOG_PATH = os.environ.get("NOVASIGHT_CATALOG_PATH") or _CFG_CATALOG_PATH


# ══════════════════════════════════════════════════════════════════════════════
#  v2 CONFIG  (column layout, accepted grades, known values)
# ══════════════════════════════════════════════════════════════════════════════

# ── Column positions (0-indexed) — ADJUST to match the real sheet ────
SEQ_COL             = 0   # student row: sequence number
GENDER_COL          = 1   # student row: gender
YEARLEVEL_COL       = 2   # student row: year level

# The subject grid: same column span on BOTH the code row and the
# student row underneath it. Codes on top, grades below, aligned.
SUBJ_FIRST_COL      = 3   # col D
SUBJ_LAST_COL       = 15  # col P (inclusive)

# Per-student totals that sit to the right of the subject grid.
SUBJ_COUNT_COL      = 16  # col Q — subjects enrolled (as the sheet counts them)
UNITS_ENROLLED_COL  = 17  # col R — credit units enrolled
UNITS_EARNED_COL    = 18  # col S — credit units earned
GWA_COL             = 19  # col T — the registrar's own GWA (credit-weighted)

# ── Filename validation (rule: "May format ng name file") ────────────
FILENAME_REGEX = re.compile(
    r'^\d{4}-[12][_\-\s]+Student[_\-\s]+Performance[_\-\s]+Dataset\.(xlsx|xls|csv)$',
    re.IGNORECASE,
)

# ── Accepted grade range ──────────────────────────────────────────────
OFFICIAL_GRADES = [1.00, 1.25, 1.50, 1.75, 2.00, 2.25, 2.50, 2.75, 3.00, 4.00, 5.00]
GRADE_MIN, GRADE_MAX = 1.0, 5.0
SNAP_TOLERANCE = 0.02   # how close a numeric value must be to an official grade to be
                         # treated as a plain rounding slip and auto-accepted quietly.
                         # Anything further than this (but still in range) is a GWA/typo
                         # warning per your rule — flagged, NOT thrown away.

# ── Status keywords kept LITERAL (never collapsed into each other) ───
# DRP, UDR, W, INC, NGA, CRD — each stays as its own status string.
# CRD = credited: it has no numeric grade but means the subject was
# PASSED, so it counts as credits earned (see course_catalog_checker).
STATUS_KEYWORDS = {"DRP", "UDR", "W", "INC", "NGA", "CRD", "FAILED"}
# NOTE: NULL_WARNING_CATEGORIES + HIGHLIGHT_CATEGORIES + WarningCollector
# now live in warnings_core.py (shared with course_catalog_checker.py).

# ── Known-value lists for typo/.upper() normalization ─────────────────
KNOWN_GENDERS = ["MALE", "FEMALE"]

# CAHS is one centralized department covering several programs —
# all of these normalize to the single tag "CAHS".
CAHS_ALIASES = ["CAHS", "CAHS-SOM", "CAHS-SON", "CAHS-SPHCD", "CNM"]

# NOTE: DOAS and COBA are REAL college tags in the registrar workbook,
# not typos. Without them here, fuzzy-match silently "corrects" DOAS to
# COAS (0.75) and COBA to CBA (0.86) — a wrong auto-fix that looks
# clean in the output. Adding them makes both exact matches.
KNOWN_COLLEGES = [
    "CAHS", "CBA", "CCST", "CEA", "COAS", "COBA", "CTEC", "DOAS",
]

# "IRREGULAR" is the literal spelling in the sheet; listing it keeps it
# an exact match instead of emitting a typo warning on every irregular
# student (607 of them in 2022-1 alone).
KNOWN_YEAR_LEVELS = [
    "1ST YEAR", "2ND YEAR", "3RD YEAR", "4TH YEAR", "IRREG", "IRREGULAR",
]

# Subject-count sanity range — outside this, the student's row is held
# back from the training dataset and flagged (rule: "kapag sumobra wag
# muna ienclude"). 13 = the full width of the subject grid (cols D..P),
# so a student who legitimately fills the grid is not excluded.
EXPECTED_SUBJECT_COUNT_RANGE = (1, 13)

TYPO_CUTOFF = 0.72   # difflib similarity cutoff for fuzzy/typo correction

# Program names need their OWN, far stricter cutoff. They are long and
# share almost all their text ("Bachelor of Science in ..."), so at 0.72
# difflib happily folds Electrical Engineering into Electronics
# Engineering, and Computer Science into Computer Engineering. That is
# not a cosmetic problem: merging two programs makes their per-program
# Seq numbers collide, and every collision then looks like a conflicting
# duplicate student — 2,671 of them, all Seq-nulled and dropped from
# training, from 9 bad merges. Only a near-identical string should be
# treated as a misspelling of a program name.
TYPO_CUTOFF_COURSE = 0.95


def validate_filename(path: str) -> tuple[bool, str]:
    name = os.path.basename(path)
    if FILENAME_REGEX.match(name):
        return True, "OK"
    return False, (
        f"Hindi tugma ang filename format: '{name}'. "
        f"Kailangan: 'YYYY-S Student-Performance Dataset.xlsx' "
        f"(hal. '2022-1 Student-Performance Dataset.xlsx')."
    )


# ════════════════════════════════════════════════════════════════════
# 3. TYPO / .upper() NORMALIZATION  (Gender, College, Course, Year Level, status words)
# ════════════════════════════════════════════════════════════════════

def _clean_upper(v) -> str | None:
    if v is None:
        return None
    s = str(v).strip().upper()
    return s if s else None


def fuzzy_match(value: str, known_values: list[str], cutoff: float = TYPO_CUTOFF) -> str | None:
    """Returns the closest known value if value looks like a typo of one
    of them, else None (meaning: leave it as-is / flag it)."""
    if value in known_values:
        return value
    match = difflib.get_close_matches(value, known_values, n=1, cutoff=cutoff)
    return match[0] if match else None


def normalize_gender(raw, warn: WarningCollector, ref: str) -> str | None:
    v = _clean_upper(raw)
    if v is None:
        return None
    if v in KNOWN_GENDERS:
        return v
    fixed = fuzzy_match(v, KNOWN_GENDERS)
    if fixed:
        warn.add("Typo (Gender)", f"'{raw}' → auto-corrected to '{fixed}'", ref)
        return fixed
    warn.add(
        "Unrecognised Gender",
        f"'{raw}' does not match Male/Female (no close fuzzy match). Row is NOT removed; value kept as '{v}' for review.",
        ref,
    )
    return v  # kept as-is, uppercased, for manual review



# Every college label the normalizer treats as an exact match or a fuzzy
# candidate: v2's known list + CAHS sub-units + this module's sheet aliases
# (COEA, DOAS, COBA, ...).
_COLLEGE_POOL = sorted(set(KNOWN_COLLEGES) | set(CAHS_ALIASES) | set(SHEET_COLLEGE_MAP))


def normalize_college(raw, warn: WarningCollector, ref: str) -> str | None:
    """Web-app version: aliases are UNIFIED through SHEET_COLLEGE_MAP
    (COEA->CEA, DOAS->COAS, COBA->CBA, CAHS sub-units->CAHS) because the
    dashboards' COLLEGE_MAP expects exactly six college labels. v2's
    standalone script keeps DOAS/COBA as their own tags; here they are
    recognised as real tags (so never fuzzy-"corrected" wrongly) and then
    folded into the label the rest of the system already uses."""
    v = _clean_upper(raw)
    if v is None:
        return None
    if v in SHEET_COLLEGE_MAP:
        unified = SHEET_COLLEGE_MAP[v]
        if unified != v:
            category = "CAHS centralization" if unified == "CAHS" else "College alias"
            warn.add(category, f"'{raw}' → consolidated to '{unified}'", ref)
        return unified
    fixed = fuzzy_match(v, _COLLEGE_POOL)
    if fixed:
        unified = SHEET_COLLEGE_MAP.get(fixed, fixed)
        warn.add("Typo (College)", f"'{raw}' → auto-corrected to '{unified}'", ref)
        return unified
    warn.add(
        "Unrecognised College",
        f"'{raw}' does not match any known college (no fuzzy match). NOT removed; kept as '{v}' in the outputra ma-review — baka bagong college o typo "
        f"na sobrang layo for ma-guess nang tama.",
        ref,
    )
    return v


def normalize_course(raw, warn: WarningCollector, ref: str, known_courses: set,
                     display: dict | None = None) -> str | None:
    """known_courses accumulates as the workbook is read — first time a
    course name is seen it's added; later near-duplicates (typos of it)
    get corrected to the first spelling seen.

    v2 upper-cases course names for matching. `display` (optional) records
    the FIRST-SEEN original spelling of each upper-cased name so the web app
    can keep storing "Bachelor of Science in ..." exactly as before — the
    dashboards filter on that spelling, and changing its case would split
    every course into two on the charts."""
    v = _clean_upper(raw)
    if v is None:
        return None
    if v in known_courses:
        return v
    fixed = fuzzy_match(v, list(known_courses), cutoff=TYPO_CUTOFF_COURSE)
    if fixed:
        warn.add("Typo (Course)", f"'{raw}' → auto-corrected to '{fixed}'", ref)
        return fixed
    known_courses.add(v)
    if display is not None:
        display[v] = str(raw).strip()
    return v


def normalize_year_level(raw, warn: WarningCollector, ref: str) -> str | None:
    v = _clean_upper(raw)
    if v is None:
        return None
    if "IRREG" in v:
        # Irregular is its OWN category — never collapsed into "Unknown".
        # Both "IRREG" and the sheet's full "IRREGULAR" are accepted
        # spellings, so neither counts as a typo; anything else that
        # merely CONTAINS "IRREG" still gets flagged as a correction.
        if v not in ("IRREG", "IRREGULAR"):
            warn.add("Typo (Year Level)", f"'{raw}' → auto-corrected to 'IRREG'", ref)
        return "IRREG"
    if v in KNOWN_YEAR_LEVELS:
        return v
    fixed = fuzzy_match(v, KNOWN_YEAR_LEVELS)
    if fixed:
        warn.add("Typo (Year Level)", f"'{raw}' → auto-corrected to '{fixed}'", ref)
        return fixed
    warn.add(
        "Unrecognised Year Level",
        f"'{raw}' does not match 1st-4th Year o Irregular (no fuzzy match). NOT removed; kept as '{v}' in the outputra ma-review.",
        ref,
    )
    return v


# ════════════════════════════════════════════════════════════════════
# 4. SEMESTER / ACADEMIC YEAR NORMALIZATION
#    (rule: "I check kung 1st sem" + "kapag 2022 make it 2022-2023")
# ════════════════════════════════════════════════════════════════════

def normalize_semester_year(raw_year, raw_sem, warn: WarningCollector, ref: str):
    """raw_year can come in as '2022' or already '2022-2023'.
    raw_sem can come in as '1', '1st', 'First Semester', etc."""
    year_str = str(raw_year).strip()
    if re.fullmatch(r"\d{4}", year_str):
        start = int(year_str)
        academic_year = f"{start}-{start + 1}"
    elif re.fullmatch(r"\d{4}-\d{4}", year_str):
        academic_year = year_str
    else:
        warn.add(
            "Unrecognised Academic Year",
            f"'{raw_year}' does not match 'YYYY' or 'YYYY-YYYY' format. NOT removed; "
            f"kept as '{year_str}' in the outputra ma-review.",
            ref,
        )
        academic_year = year_str

    sem_str = _clean_upper(raw_sem) or ""
    if sem_str in ("1", "1ST", "1ST SEM", "1ST SEMESTER", "FIRST", "FIRST SEMESTER"):
        semester = "1st Semester"
    elif sem_str in ("2", "2ND", "2ND SEM", "2ND SEMESTER", "SECOND", "SECOND SEMESTER"):
        semester = "2nd Semester"
    elif "SUM" in sem_str:
        semester = "Summer"
    else:
        warn.add(
            "Unrecognised Semester",
            f"'{raw_sem}' does not match 1st/2nd/Summer (no fuzzy match). NOT removed; "
            f"kept as '{sem_str}' in the outputra ma-review.",
            ref,
        )
        semester = sem_str

    return academic_year, semester


# ════════════════════════════════════════════════════════════════════
# 5. GRADE PARSING  — the core rule set
# ════════════════════════════════════════════════════════════════════
# Return shape: (grade_value: float|None, status: str|None, warnings appended)
#   grade_value is set only for a real numeric grade (1.00-5.00).
#   status is one of DRP / UDR / W / INC / NGA / CRD / FAILED, kept LITERAL — never
#   collapsed into each other, never turned into a numeric sentinel.

# Placeholder values the registrar sometimes writes instead of a real
# grade or status. All mean "nothing recorded here" — treated as DRP.
BLANK_PLACEHOLDERS = {"-", "--", "—", "n/a", "na", "none", "*"}

def parse_grade_v2(raw, credit_units, credits_earned, warn: WarningCollector, ref: str):
    if raw is None or (isinstance(raw, str) and raw.strip() == ""):
        # Rule: blank/0 grade cell => DRP (this is the ONE conversion allowed)
        warn.add("Grade blank → DRP", "Grade cell is blank — treated as DRP", ref)
        _cross_check_credits(credit_units, credits_earned, "DRP", warn, ref)
        return None, "DRP"

    s = str(raw).strip()

    # Dash or other "nothing recorded" placeholders → same as blank → DRP
    if s.lower() in BLANK_PLACEHOLDERS:
        warn.add(
            "Grade blank → DRP",
            f"'{s}' sa grade cell — placeholder value — treated as DRP",
            ref,
        )
        _cross_check_credits(credit_units, credits_earned, "DRP", warn, ref)
        return None, "DRP"

    # ── Slash case: status beside a grade, e.g. "INC/2.75" ───────────
    if "/" in s:
        left, right = [p.strip() for p in s.split("/", 1)]
        left_u, right_u = left.upper(), right.upper()

        # 5.00 on EITHER side = FAILED regardless of what the other side says.
        # "INC/5.00", "NGA/5.00", even "5.00/2.75" — the failing grade wins.
        left_num  = _try_float(left)
        right_num = _try_float(right)
        if left_num == 5.00 or right_num == 5.00:
            warn.add(
                "Slash resolved → FAILED",
                f"'{s}' → 5.00 found in slash grade — always FAILED, treated as FAILED",
                ref,
            )
            return None, "FAILED"

        # whichever side is a valid numeric grade is the "winner"; status is dropped
        for cand in (right, left):
            num = _try_float(cand)
            if num is not None:
                accepted, note = _validate_numeric_grade(num, warn, ref)
                if accepted is not None:
                    warn.add(
                        "Slash resolved",
                        f"'{s}' → status removed, grade '{accepted:.2f}' used",
                        ref,
                    )
                    return accepted, None
        # no numeric side found. CRD (credited = passed) beats a pending
        # status like INC, e.g. "INC/CRD" -> CRD; it stays literal.
        if "CRD" in (left_u, right_u):
            warn.add(
                "Slash resolved",
                f"'{s}' → CRD (credited/passed) used, accompanying status removed",
                ref,
            )
            return None, "CRD"
        # otherwise fall through, treat as plain status text
        s = left_u if left_u in STATUS_KEYWORDS else right_u

    su = s.upper()

    # ── Status keywords — kept literal, never renamed into each other ─
    if su in STATUS_KEYWORDS:
        if su == "NGA":
            warn.add("NGA found", f"NGA (No Grade Assigned) — requires manual review", ref)
        if su in ("UDR", "W"):
            # explicit: do NOT rewrite these as DRP
            pass
        _cross_check_credits(credit_units, credits_earned, su, warn, ref)
        return None, su

    # ── Numeric grade ─────────────────────────────────────────────────
    num = _try_float(s)
    if num is None:
        warn.add(
            "Invalid grade text",
            f"'{raw}' is not a number and not a recognised status keyword (DRP/UDR/W/INC/NGA/CRD/FAILED) — "
            f"no close fuzzy match found. NOT removed; original value is kept "
            f"sa Grade_Raw column ng output for ma-review.",
            ref,
        )
        return None, None

    if num == 0:
        warn.add("Grade 0 → DRP", "Grade is 0 — treated as DRP", ref)
        _cross_check_credits(credit_units, credits_earned, "DRP", warn, ref)
        return None, "DRP"

    if num == 5.00:
        warn.add("Grade 5.00 → FAILED",
                 f"Grade is 5.00 — treated as FAILED (no credit earned)", ref)
        _cross_check_credits(credit_units, credits_earned, "FAILED", warn, ref)
        return None, "FAILED"

    accepted, note = _validate_numeric_grade(num, warn, ref)
    return accepted, None


def _try_float(s) -> float | None:
    try:
        return float(str(s).strip())
    except (TypeError, ValueError):
        return None


def _validate_numeric_grade(num: float, warn: WarningCollector, ref: str):
    """Accepts only 1.00-5.00. Anything outside is rejected as invalid
    (never silently forced into range). Anything inside range but not
    an official grade point gets flagged (possible leaked-GWA OR typo),
    snapped for continuity, but NOT thrown away — matches the
    'wag itapon muna, ipakita sa modal' rule."""
    if not (GRADE_MIN <= num <= GRADE_MAX):
        warn.add(
            "Grade out of range",
            f"'{num}' is outside the 1.00–5.00 range — treated as invalid, excluded",
            ref,
        )
        return None, "out_of_range"

    nearest = min(OFFICIAL_GRADES, key=lambda g: abs(g - num))
    distance = abs(nearest - num)

    if num in OFFICIAL_GRADES:
        return round(num, 2), "official"

    # A raw value with MORE than 2 decimal places (e.g. 1.0027) is the
    # tell-tale sign of a GWA number that leaked into a per-subject
    # Grade cell — GWA cells carry that much precision, real grade
    # points never do. Flag it EVERY time this happens, even when the
    # value happens to land very close to an official grade point —
    # closeness alone doesn't rule out a leaked GWA, only the decimal
    # pattern does. Never discard it; just surface it for review.
    has_gwa_like_precision = round(num, 2) != num

    if has_gwa_like_precision:
        warn.add(
            "Di-karaniwang grade value",
            f"'{num}' may sobrang precision (higit sa 2 decimal) — possibly a GWA na "
            f"naligaw sa grade column (nearest opisyal na grade: {nearest:.2f}), "
            f"pwede ring typo lang. Nakalagay pa rin ito ({round(num, 2):.2f}), pakisuri.",
            ref,
        )
        return round(num, 2), "flagged_gwa_like"

    if distance <= SNAP_TOLERANCE:
        # clean 2-decimal value, just a hair off an official grade
        # point (e.g. 1.01) — plain rounding slip, accept quietly
        return round(nearest, 2), "snapped"

    # Clean 2-decimal value but far from any official grade point
    # (e.g. 1.10, 2.60) — not a precision artifact, just doesn't match
    # the grading scale. Still kept, still flagged.
    warn.add(
        "Di-karaniwang grade value",
        f"'{num}' is not an official grade point (nearest: {nearest:.2f}) — "
        f"possible grade typo. Value is kept; please reviewi.",
        ref,
    )
    return round(num, 2), "flagged"


def _cross_check_credits(credit_units, credits_earned, status: str, warn: WarningCollector, ref: str):
    """Rule: 'Double checker sa DRP or INC etc kapag ang Credits unit
    hindi tugma sa credits earned.' A DRP/INC/UDR/W student should
    normally have Credits Earned = 0 (or blank) — if the sheet shows
    earned credits alongside a non-passing status, that's inconsistent
    and worth a warning (not an auto-fix)."""
    cu = _try_float(credit_units)
    ce = _try_float(credits_earned)
    if status in ("DRP", "INC", "UDR", "W", "NGA", "FAILED") and ce not in (None, 0):
        warn.add(
            "Credits mismatch",
            f"Status='{status}' but has Credits_Earned={ce} (Credit_Units={cu}) — "
            f"mismatch — should be 0 if not passed",
            ref,
        )


# ════════════════════════════════════════════════════════════════════
# 6. STUDENT_ID  (rule: "Iwas Duplicate of student")
# ════════════════════════════════════════════════════════════════════

def build_student_id(seq, college: str, course: str, semester: str, academic_year: str) -> str:
    """ID_CollegeDept_CollegeCourse_Sems_Year — full sanitized names used
    (not truncated) so two different courses in the same college never
    collide into one Student_ID."""
    def tag(x):
        return re.sub(r"[^A-Z0-9]+", "", str(x).upper())
    sem_tag = "1" if "1st" in semester else ("2" if "2nd" in semester else tag(semester))
    return f"{seq}_{tag(college)}_{tag(course)}_{sem_tag}_{tag(academic_year)}"


# ════════════════════════════════════════════════════════════════════
# 7. SHEET STRUCTURE DETECTION — row-by-row
# ════════════════════════════════════════════════════════════════════

def is_course_row(row) -> bool:
    v = str(row[0]).strip().lower() if row and row[0] is not None else ""
    return any(k in v for k in ("bachelor", "doctor", "master", "diploma"))


def is_student_row(row) -> bool:
    if not row or row[SEQ_COL] is None:
        return False
    try:
        int(row[SEQ_COL])
    except (TypeError, ValueError):
        return False
    # a student row also has a gender value beside it — distinguishes it
    # from a lone subject-code row that happens to start with a number
    return row[GENDER_COL] is not None and str(row[GENDER_COL]).strip() != ""


SUBJECT_CODE_RE = re.compile(r"^[A-Z]{2,6}\d{2,4}$")


def _subject_span(row):
    """The cells of one row that sit inside the subject grid (cols D..P),
    as (column_index, value) pairs, blanks included."""
    out = []
    for c in range(SUBJ_FIRST_COL, SUBJ_LAST_COL + 1):
        out.append((c, row[c] if c < len(row) else None))
    return out


# A deliberately LOOSE code shape. SUBJECT_CODE_RE ("EGEC0103") only
# describes the current curriculum's format; the sheet also carries
# legacy codes like "EEAL-323", "CE 323a" and "ACAD" from older
# curricula. Requiring the strict form here silently loses those
# students entirely — 259 of them in 2022-1, each one read as a student
# with zero subjects. What this has to do instead is seforte a code
# cell from a prose cell (sheet titles, the university address), which
# length and the absence of commas handle well enough.
LOOSE_CODE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 .\-/&+]{0,14}$")


def _looks_like_code(v) -> bool:
    if v is None:
        return False
    s = str(v).strip()
    return bool(s) and bool(LOOSE_CODE_RE.match(s))


def is_code_row(row) -> bool:
    """A code row is the row sitting directly ABOVE a student row: cols A
    and B are blank and the subject grid holds at least one subject code.

    Only ONE cell has to look like a code for the row to qualify — the
    rest are then read as codes too, even if oddly formatted, so a single
    malformed code never costs us the whole student. Judging the
    unrecognised ones is the catalog's job, not this function's."""
    if not row or row[SEQ_COL] is not None:
        return False
    if len(row) > GENDER_COL and row[GENDER_COL] is not None:
        return False
    return any(_looks_like_code(v) for _, v in _subject_span(row))


def codes_in_row(row) -> dict:
    """{column_index: raw code} for every non-blank cell in the grid."""
    return {
        c: v for c, v in _subject_span(row)
        if v is not None and str(v).strip() != ""
    }


def grades_in_row(row) -> dict:
    """{column_index: raw grade} for the student row's grid — blanks
    INCLUDED, because a blank sitting under a real code is a genuine
    empty grade cell (the 'blank → DRP' rule), while a blank with no
    code above it simply means the student took fewer subjects."""
    return {c: v for c, v in _subject_span(row)}




# ── Legacy numeric encoding (what engineer_features / the DB expect) ──────────
# v2 keeps statuses LITERAL (DRP/UDR/W/INC/NGA/CRD/FAILED). The stored
# long-form table has no Status column, so at the very end of parsing they are
# folded back into the numeric sentinels the downstream datasets rely on:
#   DRP / UDR / W / NGA -> 0.0    (dropped / no grade)
#   INC / FAILED        -> 5.0    (worst-grade bucket)
#   CRD                  -> -1.0  (credited/PASSED — kept, no numeric grade
#                                  to aggregate; -1.0 sits outside the real
#                                  1.00-5.00 scale so every existing
#                                  "g > 0" grade-average filter already
#                                  excludes it, same as it does for 0.0)
_ZERO_STATUSES = {"DRP", "UDR", "W", "NGA"}
_FIVE_STATUSES = {"INC", "FAILED"}
_CRD_STATUSES  = {"CRD"}
CRD_GRADE_SENTINEL = -1.0

VALID_GRADES = OFFICIAL_GRADES   # compat alias for the old constant name


def _legacy_grade_value(grade, status) -> float | None:
    """(grade, status) from parse_grade_v2 -> the legacy numeric encoding,
    or None when the cell carries nothing storable (invalid text,
    out-of-range value)."""
    if status in _ZERO_STATUSES:
        return 0.0
    if status in _FIVE_STATUSES:
        return 5.0
    if status in _CRD_STATUSES:
        return CRD_GRADE_SENTINEL
    return grade  # real numeric grade, or None


def parse_grade(raw) -> float | None:
    """Compatibility wrapper for anything still importing the old
    single-cell parser. Runs the v2 rules and returns the legacy encoding.
    NOTE: a blank cell / "-" / 0 is now DRP -> 0.0 (v2 rule), where the old
    parser returned None for a blank."""
    grade, status = parse_grade_v2(raw, None, None, WarningCollector(), "parse_grade")
    return _legacy_grade_value(grade, status)



# ══════════════════════════════════════════════════════════════════════════════
#  KEPT FROM THE OLD PARSER (year level labels, header fallback)
# ══════════════════════════════════════════════════════════════════════════════

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


def extract_header_info(rows) -> tuple[str, str, bool]:
    """
    Scan the first 20 rows of a sheet for semester and academic year text.
    Returns (semester_str, academic_year_str, semester_matched).

    semester_matched is False when no SEM_PATTERNS text was found at all —
    `semester` still falls back to "1sem" as before (unchanged behavior for
    every existing caller), but the caller can use the flag to raise a
    "Unrecognised Semester" warning instead of silently guessing.
    """
    semester = "1sem"
    semester_matched = False
    academic_year = "Unknown"

    for row in rows[:20]:
        for cell in row:
            if cell is None:
                continue
            text = str(cell)
            for pattern, sem_val in SEM_PATTERNS.items():
                if pattern.search(text):
                    semester = sem_val
                    semester_matched = True
            m = YEAR_PATTERN.search(text)
            if m:
                academic_year = f"{m.group(1)}-{m.group(2)}"

    return semester, academic_year, semester_matched


def parse_workbook_wide(path: str, academic_year_hint: str | None, semester_hint: str | None,
                        warn: WarningCollector) -> tuple[pd.DataFrame, dict]:
    """v2 parser: one workbook -> (flattened wide-form frame, {upper course -> original spelling}).
    Hints of None fall back to each sheet's own header text."""
    wb = load_workbook(path, data_only=True, read_only=True)
    known_courses: set[str] = set()
    course_display: dict[str, str] = {}
    records = []

    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        current_college = sheet_name  # college is usually encoded per-sheet
        current_course = None
        current_student = None
        pending_codes: dict | None = None   # codes from the row just above
        pending_codes_ref: str | None = None
        # track (seq, course) -> list of row indices seen, for duplicate-seq detection
        seen_seq_in_course: dict[tuple, list[dict]] = {}
        records_before_sheet = len(records)   # snapshot before this sheet; re-numbering only touches new entries

        # year / semester: filename hint wins; otherwise read this sheet's
        # header rows (the old parser's method) so any file name still works.
        sheet_year_hint, sheet_sem_hint = academic_year_hint, semester_hint
        if sheet_year_hint is None or sheet_sem_hint is None:
            h_sem, h_ay, h_matched = extract_header_info(list(ws.iter_rows(max_row=20, values_only=True)))
            if sheet_year_hint is None and h_ay != "Unknown":
                sheet_year_hint = h_ay
            if sheet_sem_hint is None and h_matched:
                sheet_sem_hint = {"1sem": "1", "2sem": "2", "summer": "summer"}[h_sem]
        academic_year, semester = normalize_semester_year(
            sheet_year_hint if sheet_year_hint is not None else "Unknown",
            sheet_sem_hint, warn, ref=f"sheet:{sheet_name}"
        )
        college_norm = normalize_college(current_college, warn, ref=f"sheet:{sheet_name}")

        for row_idx, row in enumerate(ws.iter_rows(values_only=True), start=1):
            ref = f"{sheet_name}!row{row_idx}"

            if is_course_row(row):
                current_course = normalize_course(row[0], warn, ref, known_courses, course_display)
                pending_codes = None
                continue

            if is_code_row(row):
                # Hold it — it only means something once the student row
                # directly beneath it arrives.
                pending_codes = codes_in_row(row)
                pending_codes_ref = ref
                continue

            if is_student_row(row):
                seq_raw = row[SEQ_COL]
                gender = normalize_gender(row[GENDER_COL], warn, ref)
                year_level = normalize_year_level(row[YEARLEVEL_COL], warn, ref)

                if current_course is None:
                    warn.add("Null Course", "No course detected before this student row", ref)

                current_student = {
                    "Seq": seq_raw,
                    "College": college_norm,
                    "Course": current_course,
                    "Gender": gender,
                    "Year_Level": year_level,
                    "Academic_Year": academic_year,
                    "Semester": semester,
                    # the registrar's own totals, kept as-reported so the
                    # catalog cross-check has something to reconcile against
                    "Subject_Count_Reported": row[SUBJ_COUNT_COL] if len(row) > SUBJ_COUNT_COL else None,
                    "Units_Enrolled_Reported": row[UNITS_ENROLLED_COL] if len(row) > UNITS_ENROLLED_COL else None,
                    "Units_Earned_Reported": row[UNITS_EARNED_COL] if len(row) > UNITS_EARNED_COL else None,
                    "GWA_Reported": row[GWA_COL] if len(row) > GWA_COL else None,
                    "row_ref": ref,
                    "subjects": [],
                }

                # ── pair the grades on THIS row with the codes above ──
                grades = grades_in_row(row)
                if pending_codes is None:
                    warn.add(
                        "Null Course Code",
                        "No subject-code row above this student row — grades cannot be paired to subject codes",
                        ref,
                    )
                else:
                    for col, code_raw in sorted(pending_codes.items()):
                        grade_raw = grades.get(col)
                        code = str(code_raw).strip().upper()
                        if code == "":
                            warn.add("Null Course Code", f"No subject code in column {col}", ref)

                        grade_value, status = parse_grade_v2(
                            grade_raw, None, None, warn, f"{ref} col{col} {code}"
                        )

                        current_student["subjects"].append({
                            "Subject_Code": code,
                            # These three have no per-subject source in this
                            # workbook. The catalog fills Subject_Name and
                            # Credit_Units later, and derives Credits_Earned
                            # from the grade (units if passed, NULL if not).
                            "Subject_Name": None,
                            "Credit_Units": None,
                            "Credits_Earned": None,
                            "Grade": grade_value,
                            "Grade_Raw": grade_raw,
                            "Status": status,
                            "row_ref": ref,
                        })

                    # a grade sitting in a column with NO code above it is
                    # an orphan — flagged, never silently dropped
                    for col, g in grades.items():
                        if g is not None and str(g).strip() != "" and col not in pending_codes:
                            warn.add(
                                "Orphan grade (walang code)",
                                f"Grade value '{g}' in column {col} but no subject code "
                                f"sa code row sa itaas ({pending_codes_ref}) — pakisuri",
                                ref,
                            )

                key = (current_course, seq_raw)
                seen_seq_in_course.setdefault(key, []).append(current_student)
                pending_codes = None
                continue

        # ── duplicate Seq detection WITHIN each course ──────────────
        for (course, seq_raw), occurrences in seen_seq_in_course.items():
            if len(occurrences) <= 1:
                continue
            first, *dupes = occurrences
            for dup in dupes:
                if _students_identical(first, dup):
                    # Exact match — silently drop the repeat
                    warn.add(
                        "Duplicate identifier (exact)",
                        f"Seq {seq_raw} in course '{course}' appears multiple times (exact duplicate) — "
                        f"tinanggal ang pangalawang entry",
                        dup["row_ref"],
                    )
                    dup["_drop"] = True
                else:
                    # Conflicting: same Seq, different data — two different students.
                    # Mark the duplicate so the final re-numbering pass below
                    # can assign it a proper sequential Seq. The original Seq
                    # is kept in _orig_seq for the warning message only.
                    dup["_conflicting_dup"] = True
                    dup["_orig_seq"] = seq_raw
                    warn.add(
                        "Duplicate Subject (same student)",
                        f"Seq {seq_raw} in course '{course}' appears multiple times with different content "
                        f"(grades/subjects/atbp.) — ire-renumber sa sequential Seq sa huling pass",
                        dup["row_ref"],
                    )

        for students in seen_seq_in_course.values():
            for s in students:
                if s.get("_drop"):
                    continue
                records.append(s)

        # ── sequential re-numbering per course (this sheet only) ────
        # Every student in this sheet gets a clean 1-based Seq within
        # their course — no gaps from missing Seq, no collisions from
        # conflicting duplicates.  Sheet order (= Excel row order) is the
        # only thing that determines who gets which number.
        # e.g.  sheet had: 1, 1(conflict), 2, 3, 4
        #       result:     1,           2, 3, 4, 5
        # e.g.  sheet had: 1, 3, 4   (gap)
        #       result:     1, 2, 3
        from collections import defaultdict as _dd
        _course_buckets: dict[str, list] = _dd(list)
        for rec in records[records_before_sheet:]:   # only THIS sheet
            _course_buckets[rec.get("Course") or ""].append(rec)

        for course_key, bucket in _course_buckets.items():
            for counter, rec in enumerate(bucket, start=1):
                orig = rec.get("_orig_seq", rec["Seq"])
                rec["Seq"] = counter
                if rec.get("_conflicting_dup"):
                    for it in reversed(warn.items):
                        if it["category"] == "Duplicate Subject (same student)"                                 and it["ref"] == rec["row_ref"]:
                            it["message"] = (
                                f"Seq {orig} in course '{course_key}' paulit-ulit pero "
                                f"magkaiba ang laman (grades/subjects/atbp.) — "
                                f"ibinigay ang bagong Seq {counter}"
                            )
                            break

    wb.close()
    return _flatten_records(records, warn), course_display


def _students_identical(a: dict, b: dict) -> bool:
    """True only if every subject (code, grade, status) matches exactly
    AND gender/year_level match — i.e. genuinely the same rows repeated,
    not two different people who happen to share a seq number."""
    if a["Gender"] != b["Gender"] or a["Year_Level"] != b["Year_Level"]:
        return False
    a_subj = sorted((s["Subject_Code"], s["Grade"], s["Status"]) for s in a["subjects"])
    b_subj = sorted((s["Subject_Code"], s["Grade"], s["Status"]) for s in b["subjects"])
    return a_subj == b_subj


def _ay_to_year_numeric(ay: str) -> int | None:
    """'2022-2023' or '2022' → 2022 (the starting year of the AY)."""
    try:
        return int(str(ay).split("-")[0].strip())
    except (ValueError, AttributeError):
        return None


def _sem_to_numeric(sem: str) -> int | None:
    """'1st Semester' → 1, '2nd Semester' → 2, 'Summer' → 3."""
    if not sem:
        return None
    s = str(sem).lower()
    if "1" in s or "first" in s:
        return 1
    if "2" in s or "second" in s:
        return 2
    if "sum" in s:
        return 3
    return None


def _flatten_records(records: list[dict], warn: WarningCollector) -> pd.DataFrame:
    rows = []
    for rec in records:
        subj_count = len(rec["subjects"])
        exclude = rec.get("_exclude_training", False)

        if subj_count == 0:
            warn.add("Zero subjects", "Student has no subject rows", rec["row_ref"])
            exclude = True
        elif not (EXPECTED_SUBJECT_COUNT_RANGE[0] <= subj_count <= EXPECTED_SUBJECT_COUNT_RANGE[1]):
            warn.add(
                "Abnormal subject count",
                f"{subj_count} subjects — outside expected range "
                f"{EXPECTED_SUBJECT_COUNT_RANGE}, excluded from training for nowama",
                rec["row_ref"],
            )
            exclude = True

        # Subject count mismatch: col Q (reported) ≠ actual encoded subjects.
        # diff > 0 → sheet claims more subjects than the code row has
        #   → may naiwan na subject na hindi na-encode, incomplete record.
        # diff < 0 → script found MORE than reported
        #   → may extra code sa code row na hindi dapat kasama, o maling Q.
        # Either way, the record is unreliable — excluded from training.
        sc_reported = _try_float(rec.get("Subject_Count_Reported"))
        if subj_count > 0 and sc_reported is not None and abs(sc_reported - subj_count) > 0:
            warn.add(
                "Subject Count mismatch",
                f"Sheet (col Q) reports {int(sc_reported)} subject(s) but "
                f"{subj_count} lang ang na-encode sa code row — possible typo sa col Q "
                f"o may naiwan/dagdag na subject, hindi isasama sa training",
                rec["row_ref"],
            )
            exclude = True

        if rec["Seq"] is None:
            exclude = True  # null Seq is always excluded per rule

        student_id = (
            build_student_id(rec["Seq"], rec["College"], rec["Course"], rec["Semester"], rec["Academic_Year"])
            if rec["Seq"] is not None else None
        )

        # ── GWA ──────────────────────────────────────────────────────
        # col T carries the registrar's own GWA. A blank OR a 0 there means
        # "never filled in" (a real GWA is never below 1.00), so it is NOT
        # trusted as a value. It is left empty here and filled later from
        # the grades with the Philippine credit-weighted formula
        # (Σ(units × grade) / Σ(units)) — that needs the catalog's credit
        # units, so it happens in course_catalog_checker, and anything it
        # could not fill is settled by finalize_gwa() below.
        grades = [s["Grade"] for s in rec["subjects"] if s["Grade"] is not None]
        gwa_unweighted = round(sum(grades) / len(grades), 2) if grades else None

        gwa_reported = _try_float(rec.get("GWA_Reported"))
        if gwa_reported is None or gwa_reported <= 0:
            gwa, gwa_source = None, "Missing"
        else:
            gwa, gwa_source = round(gwa_reported, 5), "Reported"

        # total credit units earned: the sheet's own value, kept here as
        # reported. course_catalog_checker replaces it with the total
        # rebuilt from the grades when the sheet's is blank or SHORT of
        # what the passing grades add up to (needs the catalog's units).
        # Units_Earned_Reported always keeps the original.
        units_earned = _try_float(rec.get("Units_Earned_Reported"))
        units_earned_source = "Reported" if units_earned is not None else "Missing"

        for subj in rec["subjects"]:
            rows.append({
                "Student_ID": student_id,
                "Seq": rec["Seq"],
                "College": rec["College"],
                "Course": rec["Course"],
                "Gender": rec["Gender"],
                "Year_Level": rec["Year_Level"],
                "Academic_Year": rec["Academic_Year"],
                "Semester": rec["Semester"],
                "Subject_Code": subj["Subject_Code"],
                "Subject_Name": subj["Subject_Name"],
                "Credit_Units": subj["Credit_Units"],
                "Credits_Earned": subj["Credits_Earned"],
                "Grade": subj["Grade"],
                "Grade_Raw": subj["Grade_Raw"],
                "Status": subj["Status"],
                "Subject_Count": subj_count,
                "Subject_Count_Reported": rec.get("Subject_Count_Reported"),
                "Units_Enrolled_Reported": rec.get("Units_Enrolled_Reported"),
                "Units_Earned_Reported": rec.get("Units_Earned_Reported"),
                "Units_Earned": units_earned,
                "Units_Earned_Source": units_earned_source,
                "GWA": gwa,
                "GWA_Source": gwa_source,
                "GWA_Reported": _try_float(rec.get("GWA_Reported")),
                "GWA_Unweighted": gwa_unweighted,
                "Include_In_Training": not exclude,
                # ── temporal ordering columns ─────────────────────────────────
                # Year_Numeric and Sem_Numeric allow export_datasets.py and
                # eval_models.py to do temporal cross-validation (train on past
                # semesters, test on the latest) without re-parsing the AY string.
                # Convention: 2022-1 → Year=2022, Sem=1; 2022-2 → Year=2022, Sem=2
                # Semester order within a year: 1st=1, 2nd=2, Summer=3
                "Year_Numeric": _ay_to_year_numeric(rec["Academic_Year"]),
                "Sem_Numeric":  _sem_to_numeric(rec["Semester"]),
                "_Student_Key": rec["row_ref"],   # internal; dropped on export
            })
    return pd.DataFrame(rows)


# ════════════════════════════════════════════════════════════════════
# 8b. FINALIZE GWA — whatever the catalog step could not fill
# ════════════════════════════════════════════════════════════════════

def finalize_gwa(df: pd.DataFrame, warn: WarningCollector) -> pd.DataFrame:
    """Runs AFTER the catalog step. A student whose GWA is still empty
    here is one the catalog step did not settle (no --catalog, or one of
    their subject codes isn't in the catalog). Two outcomes:

      • NO numeric grade at all (puro DRP/INC/W/NGA/UDR o blangko) ->
        nothing to sum, so GWA = 0.0 exactly as the registrar shows it.
        This is accurate, not invalid: the student is identified
        (GWA_Source), kept, and stays in training.
      • they DO have numeric grades -> the plain (UNWEIGHTED) average is
        used as a stop-gap, clearly labelled and warned about.
    """
    still_missing = df["GWA"].isna()
    if not still_missing.any():
        return df

    for key, group in df[still_missing].groupby("_Student_Key", sort=False):
        unweighted = group["GWA_Unweighted"].iloc[0]
        if pd.isna(unweighted):
            # No grades at all — can't compute any GWA; mark MISSING.
            # Student stays in training (same as the catalog path).
            course_catalog_checker.mark_no_summable_gwa(df, group.index, key, warn, key)
        else:
            df.loc[group.index, "GWA"] = unweighted
            df.loc[group.index, "GWA_Source"] = "Unweighted average (fallback)"
            warn.add(
                "GWA fallback (unweighted average)",
                f"No GWA in col T and credit-weighted GWA cannot be computed (no --catalog, "
                f"may subject na wala sa catalog, o kulang ang units sa catalog) — pansamantalang "
                f"ginamit ang unweighted average ({unweighted}); hindi ito katumbas ng "
                f"credit-weighted GWA, pakisuri",
                key,
            )
    return df


# ════════════════════════════════════════════════════════════════════
# 9. VALIDATION / ACCURACY  (rule: "may nulls makakabawas ito sa accuracy")
# ════════════════════════════════════════════════════════════════════

# Subject_Name / Credit_Units / Credits_Earned are deliberately NOT here.
# They have no per-subject source in the grade workbook, so counting them
# as nulls would peg accuracy at a permanent ~60% and make the number
# meaningless. When a catalog is supplied they get filled in, and the
# catalog's own columns are checked on that side instead.
# Accuracy = share of grade cells that parsed into a valid value.
# Only Grade_Raw matters here — identity fields (Seq/College/Course) are
# nearly always present and would inflate the number; GWA is computed, not
# a raw input cell. This makes the accuracy figure match what you see in
# standalone preprocess_v2.py testing (e.g. 99.98% not 100%).
CRITICAL_COLUMNS = ["Grade_Raw"]


def compute_accuracy(df: pd.DataFrame) -> float:
    if df.empty:
        return 0.0
    total_cells = len(df) * len(CRITICAL_COLUMNS)
    null_cells = df[CRITICAL_COLUMNS].isna().sum().sum()
    return round(100 * (total_cells - null_cells) / total_cells, 2) if total_cells else 0.0




# ══════════════════════════════════════════════════════════════════════════════
#  WARNING AGGREGATION  (WarningCollector items -> compact warning dicts)
# ══════════════════════════════════════════════════════════════════════════════

def _warning_sheet(ref) -> str:
    """Sheet part of a warning ref ("CEA!row12 col5 EGEC0103" -> "CEA",
    "sheet:CEA" -> "CEA"); "—" when the ref carries no sheet."""
    if not ref:
        return "—"
    s = str(ref)
    if s.startswith("sheet:"):
        return s[len("sheet:"):] or "—"
    return s.split("!", 1)[0] if "!" in s else "—"


def _aggregate_warnings(items, keep_individual: int = 3, max_refs: int = 15,
                        max_len: int = 1500) -> list[dict]:
    """
    v2 raises one warning per offending CELL (thousands on a real file);
    the modal / preprocessing_warnings table works per (category, sheet).
    Up to `keep_individual` hits in a group are kept as-is; more than that
    are collapsed into ONE warning carrying the count, two examples and the
    first `max_refs` refs so nothing becomes untraceable. Tier is added by
    the caller (parse_workbook_v2) via _tier_for_category().
    """
    groups: dict[tuple, list[dict]] = {}
    for it in items:
        key = (it.get("category"), _warning_sheet(it.get("ref")))
        groups.setdefault(key, []).append(it)

    out: list[dict] = []
    for (category, sheet), grp in groups.items():
        if len(grp) <= keep_individual:
            for g in grp:
                out.append({"category": category, "message": str(g.get("message", ""))[:max_len],
                            "ref": g.get("ref")})
            continue
        refs = [str(g["ref"]) for g in grp if g.get("ref")]
        ref_txt = ", ".join(refs[:max_refs]) + (f", +{len(refs) - max_refs} more" if len(refs) > max_refs else "")
        where = f" in sheet '{sheet}'" if sheet != "—" else ""
        msg = (f"{len(grp)} pangyayari{where} — halimbawa: {grp[0].get('message', '')} | "
               f"{grp[1].get('message', '')}" + (f" — Refs: {ref_txt}" if ref_txt else ""))
        out.append({"category": category, "message": msg[:max_len],
                    "ref": sheet if sheet != "—" else None})

    # preprocessing_warnings.category is varchar(100) and .ref varchar(200);
    # save_preprocessing_warnings() bulk-inserts without clipping, so one
    # over-long value would fail the WHOLE insert (and the modal would show
    # no warnings at all). Clip here instead.
    for o in out:
        o["category"] = str(o["category"])[:100]
        if o.get("ref") is not None:
            o["ref"] = str(o["ref"])[:200]
    return out


# ══════════════════════════════════════════════════════════════════════════════
#  v2 (wide) OUTPUT  ->  LEGACY LONG-FORM SCHEMA
# ══════════════════════════════════════════════════════════════════════════════

_LEGACY_SEM = {"1st Semester": "1sem", "2nd Semester": "2sem", "Summer": "summer"}

LEGACY_LONG_COLUMNS = [
    "Student_ID", "Student_Seq", "Gender", "College", "Course",
    "Year_Level", "Year_Level_Num", "Subject", "Subject_Name", "Grade",
    "Semester", "Year",
]


def _wide_to_legacy_long(wide: pd.DataFrame, course_display: dict,
                         warn: WarningCollector, info: dict | None = None) -> pd.DataFrame:
    """
    Translate v2's flattened frame into the long-form table the rest of the
    web app has always consumed (LEGACY_LONG_COLUMNS + one internal helper,
    `_GWA_V2`, that engineer_features() uses and then drops).

      Gender        MALE/FEMALE -> "Male"/"Female", anything else "Unknown"
      Year_Level    v2 label -> parse_year_level() ("1st Year"/"Irregular"...)
      Semester      "1st Semester" -> "1sem" (unknown falls back to "1sem")
      Course        upper-cased match key -> first-seen original spelling
      Grade         statuses folded to 0.0 / 5.0 / -1.0 (see _legacy_grade_value)
    Rows with nothing storable (invalid text, out-of-range) are left
    out, and — when HOLD_BACK_EXCLUDED_STUDENTS — so are students v2 marked
    Include_In_Training = False.
    """
    if info is not None:
        info["excluded_students"] = 0
        info["excluded_rows"] = 0

    if wide.empty:
        return pd.DataFrame(columns=LEGACY_LONG_COLUMNS + ["_GWA_V2"])

    df = wide.copy()

    held_students = 0
    if "Include_In_Training" in df.columns:
        held = ~df["Include_In_Training"].astype(bool)
        held_students = int(df.loc[held, "_Student_Key"].nunique())
        if HOLD_BACK_EXCLUDED_STUDENTS:
            if info is not None:
                info["excluded_students"] = held_students
                info["excluded_rows"] = int(held.sum())
            df = df[~held]
    df = df[df["Student_ID"].notna()]

    if held_students:
        if HOLD_BACK_EXCLUDED_STUDENTS:
            warn.add("Hindi isinama sa dataset",
                     f"{held_students} estudyante ang hindi isinama sa dataset dahil hindi "
                     f"maaasahan ang record nila (see related warnings: Subject "
                     f"Count mismatch, Abnormal subject count, Zero subjects, atbp.)",
                     "file")
        else:
            warn.add("Nakatakdang i-exclude (isinama pa rin)",
                     f"{held_students} students have unreliable records but "
                     f"isinama pa rin (HOLD_BACK_EXCLUDED_STUDENTS=False)", "file")

    status = df["Status"]
    grade = pd.to_numeric(df["Grade"], errors="coerce")
    # Status rows (DRP/UDR/W/NGA/INC/CRD/FAILED) keep Grade = NaN.
    # They are NOT encoded as 0.0 / 5.0 / -1.0 — the Status column carries
    # the meaning. Grade is only populated for rows with an actual numeric grade.
    status_rows = status.isin(_ZERO_STATUSES | _FIVE_STATUSES | _CRD_STATUSES)

    # Only truly unresolvable cells (invalid text with no status) are dropped.
    no_grade = grade.isna() & ~status_rows
    if no_grade.any():
        warn.add("Grade rows nilaktawan",
                 f"{int(no_grade.sum())} grade cell(s) with no assignable grade "
                 f"(invalid na text, o wala sa 1.00-5.00) — hindi isinama sa long-form table",
                 "file")
    df = df[~no_grade].copy()
    grade  = grade[~no_grade]
    status = status[~no_grade]

    yl_cache = {v: parse_year_level(v) for v in df["Year_Level"].dropna().unique()}
    unknown_yl = (None, "Unknown")

    out = pd.DataFrame({
        "Student_ID":     df["Student_ID"].values,
        "Student_Seq":    pd.to_numeric(df["Seq"], errors="coerce").astype("Int64").astype(object).values,
        "Gender":         df["Gender"].map({"MALE": "Male", "FEMALE": "Female"}).fillna("Unknown").values,
        "College":        df["College"].fillna("Unknown").values,
        "Course":         df["Course"].map(lambda c: course_display.get(c, c)).fillna("Unknown").values,
        "Year_Level":     df["Year_Level"].map(lambda v: yl_cache.get(v, unknown_yl)[1]).values,
        "Year_Level_Num": df["Year_Level"].map(lambda v: yl_cache.get(v, unknown_yl)[0]).values,
        "Subject":        df["Subject_Code"].values,
        "Subject_Name":   df["Subject_Name"].fillna(df["Subject_Code"]).values,
        "Grade":          grade.values,
        # Literal status string — preserved so separation_csv.py can count
        # DRP / UDR / W / NGA / INC / FAILED / CRD independently per student.
        # The Grade column above still carries the numeric sentinel (0.0/5.0/-1.0)
        # for GWA computation; Status is additive and does not change Grade logic.
        "Status":         status.values,
        "Semester":       df["Semester"].map(_LEGACY_SEM).fillna("1sem").values,
        "Year":           df["Academic_Year"].fillna("Unknown").values,
        # Per-student totals (cols R/S on the sheet, same value repeated
        # on every subject row for that student in `wide`). Carried
        # through here so engineer_features() can fold them into
        # student_agg (-> semester_uploads) and compute Completion_Rate;
        # previously dropped entirely by this translation step, so
        # neither semester_uploads nor longform_uploads ever stored them.
        "Units_Enrolled_Reported": pd.to_numeric(df["Units_Enrolled_Reported"], errors="coerce").values
            if "Units_Enrolled_Reported" in df.columns else np.nan,
        "Units_Earned":            pd.to_numeric(df["Units_Earned"], errors="coerce").values
            if "Units_Earned" in df.columns else np.nan,
        "_GWA_V2":        pd.to_numeric(df["GWA"], errors="coerce").values,
    })
    out["Student_Seq"] = out["Student_Seq"].astype(int)
    out["Year_Level_Num"] = pd.to_numeric(out["Year_Level_Num"], errors="coerce")
    return out.reset_index(drop=True)


def _accuracy_stats(wide: pd.DataFrame) -> dict:
    """v2's accuracy (share of non-null CRITICAL_COLUMNS cells) per
    (academic_year, semester), in the {"total", "valid"} shape that
    _accuracy_pct() / write_semester_folder() already understand."""
    stats: dict = {}
    if wide.empty:
        return stats
    for (ay, sem), grp in wide.groupby(["Academic_Year", "Semester"], dropna=False):
        key = (ay if pd.notna(ay) else "Unknown", _LEGACY_SEM.get(sem, "1sem"))
        cells = len(grp) * len(CRITICAL_COLUMNS)
        nulls = int(grp[CRITICAL_COLUMNS].isna().sum().sum())
        entry = stats.setdefault(key, {"total": 0, "valid": 0})
        entry["total"] += cells
        entry["valid"] += cells - nulls
    return stats


# ══════════════════════════════════════════════════════════════════════════════
#  FILE PARSER
# ══════════════════════════════════════════════════════════════════════════════

def parse_workbook(filepath: str, warnings: list | None = None,
                   catalog_path: str | None = None,
                   info: dict | None = None) -> tuple[pd.DataFrame, dict]:
    """
    Parse one .xlsx grade workbook with the v2 rules and return
    (long-form DataFrame in the legacy schema, stats). Same signature and
    return shape as before, so run_preprocessing() / process_file() /
    parse_workbook_v2() are unaffected.

    `stats` is {(academic_year, semester): {"total": n, "valid": n}} — the
    input to the per-upload Accuracy figure (see _accuracy_stats()).

    `warnings`, if given, is a list this call APPENDS aggregated warning
    dicts to ({"category", "message", "ref"} — no "tier"; the caller resolves
    it via _tier_for_category()). None keeps the old collect-nothing behavior.

    Steps: wide parse -> catalog cross-check (if a catalog is configured) ->
    GWA settle -> accuracy -> translation to the legacy long-form schema.
    `info`, if given, is filled with {"excluded_students", "excluded_rows"}:
    the students / subject rows held back by HOLD_BACK_EXCLUDED_STUDENTS
    (process_file_v2 reports them as uploaded_dataset.excluded_row_count).

    Academic year / semester come from the "YYYY-S ..." filename when it
    matches (stored-name prefix stripped), else from each sheet's header
    text like the old parser did.
    """
    display_name = _display_filename(filepath)
    log.info(f"  Parsing: {display_name}")
    warn = WarningCollector()

    m = re.match(r"^(\d{4})-([12])", display_name)
    year_hint = m.group(1) if m else None
    sem_hint  = m.group(2) if m else None

    wide, course_display = parse_workbook_wide(filepath, year_hint, sem_hint, warn)

    def _flush():
        if warnings is not None:
            warnings.extend(_aggregate_warnings(warn.items))

    if info is not None:
        info.setdefault("excluded_students", 0)
        info.setdefault("excluded_rows", 0)

    if wide.empty:
        log.warning("    No student/grade records extracted — check the column layout in the v2 CONFIG")
        _flush()
        return pd.DataFrame(), {}

    cat = catalog_path or COURSE_CATALOG_PATH
    if cat and os.path.isfile(cat):
        backup = wide.copy()
        try:
            wide = course_catalog_checker.run_course_code_checks(wide, cat, warn)
        except Exception as e:
            log.error(f"    Course catalog check failed (non-fatal): {e}")
            warn.add("Catalog check failed", f"Hindi natapos ang course-catalog check: {e}", display_name)
            wide = backup
    else:
        reason = f"file not found: '{cat}'" if cat else "no catalog configured"
        log.info(f"    Course catalog skipped ({reason})")
        warn.add("No course catalog",
                 f"Course-code cross-check, credit-weighted GWA, and Credits_Earned were skipped "
                 f"({reason}). Set COURSE_CATALOG_PATH or NOVASIGHT_CATALOG_PATH to enable.",
                 display_name)

    wide = finalize_gwa(wide, warn)

    log.info(f"    Validation accuracy: {compute_accuracy(wide)}%")
    stats = _accuracy_stats(wide)
    long_df = _wide_to_legacy_long(wide, course_display, warn, info)
    log.info(f"      → {len(long_df):,} subject-grade records "
             f"({long_df['Student_ID'].nunique() if not long_df.empty else 0:,} students)")

    _flush()
    return long_df, stats


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
#  DUPLICATE DETECTION
# ══════════════════════════════════════════════════════════════════════════════

def check_duplicate_upload(filepath: str) -> dict | None:
    """
    SHA-256 duplicate check. Call BEFORE saving to Unprocessed_Datasets/.
    Returns existing uploaded_dataset row if duplicate, else None.
    """
    file_hash = compute_file_hash(filepath)
    return check_file_hash(file_hash)


# ══════════════════════════════════════════════════════════════════════════════
#  PARSE WORKBOOK V2 — collects structured warnings
# ══════════════════════════════════════════════════════════════════════════════

def parse_workbook_v2(filepath: str, info: dict | None = None) -> tuple[pd.DataFrame, dict, list[dict]]:
    """
    Parse all sheets of one xlsx file.
    Returns (longform_df, stats, warnings_list).

    warnings_list is a flat list of dicts for preprocessing_warnings table:
        [{"tier": "null"|"highlight"|"resolved",",
          "category": str, "message": str, "ref": str|None}, ...]

    The row/sheet/student-level checks all happen INSIDE the v2 parser now
    (WarningCollector -> parse_workbook(warnings=...)), so the old
    post-hoc _collect_warnings_from_df() scan is gone. Tier is still
    resolved centrally here via _tier_for_category() so a category is
    classified in exactly one place (warnings_core's category sets).

    Caller passes warnings_list to save_preprocessing_warnings(upload_id, warnings).
    """
    warnings: list[dict] = []
    df, stats = parse_workbook(filepath, warnings=warnings, info=info)

    for w in warnings:
        w["tier"] = _tier_for_category(w["category"])

    # Sort: null first, highlight second, plain last
    tier_order = {TIER_NULL: 0, TIER_HIGHLIGHT: 1, TIER_PLAIN: 2}  # null < highlight < resolved
    warnings.sort(key=lambda w: tier_order.get(w.get("tier", TIER_PLAIN), 2))

    return df, stats, warnings


def process_file_v2(filepath: str, upload_id: int | None = None, file_hash: str | None = None) -> dict:
    """
    Updated entry point for Flask upload route.
    Parse → feature-engineer → STAGE (not commit) → save warnings.

    CHANGED: this used to call write_semester_folder() here, which means
    the parsed data landed in the real semester_uploads/longform_uploads
    tables — the ones training and the "Training CSV" tab read from —
    BEFORE the user ever saw or confirmed the warnings modal. A cancelled
    upload had already polluted the shared tables and needed a special
    purge_semester_data() cleanup to undo it.

    Now this function only STAGES the result (stage_semester_upload(), a
    separate staged_uploads table, keyed by upload_id + file_hash). The
    REAL write (write_semester_folder(), into semester_uploads /
    longform_uploads) happens later, only inside confirm-upload's
    _run_separation_and_train() in upload_routes.py. Cancelling before
    that point now just means deleting the staged row — the shared
    tables were never touched, so purge_semester_data() is no longer
    needed on the happy path.

    `file_hash` (SHA-256 of the raw .xlsx, from check_duplicate_upload())
    is stored alongside the staged row so a re-upload of the exact same
    file — e.g. after the browser closed mid-preprocessing — can be
    recognized and resumed from the cached parse instead of re-parsing
    from scratch. See find_staged_upload_by_hash() in upload_routes.py.

    Does NOT run CSV separation — that runs after user confirms the modal.
    Returns dict with success, academic_year, semester, row counts,
    accuracy, warning_counts, and upload_id.
    """
    try:
        # Filename rule ("YYYY-S Student-Performance Dataset.xlsx") — checked
        # on the display name, i.e. without the userid_timestamp_ prefix.
        if ENFORCE_FILENAME_FORMAT:
            ok, msg = validate_filename(_display_filename(filepath))
            if not ok:
                return {"success": False, "error": msg}

        info: dict = {}
        df, stats, warnings = parse_workbook_v2(filepath, info=info)
        if df.empty:
            return {"success": False, "error": "No records parsed from file"}

        student_df, long_df = engineer_features(df)

        # (The old "Null GWA" post-check is gone: GWA is settled inside the
        # parser now — see finalize_gwa() — and every student it could not
        # give a real GWA already has its own warning.)

        ay  = df["Academic_Year"].iloc[0] if "Academic_Year" in df.columns else (
              df["Year"].iloc[0]          if "Year"          in df.columns else "Unknown")
        sem = df["Semester"].iloc[0]      if "Semester"      in df.columns else "Unknown"
        accuracy = _accuracy_pct(stats, ay, sem)

        # Save warnings to DB first (non-fatal if it fails) so warning_counts
        # exists before we build warnings_json for the staged row below.
        warning_counts = {"null": 0, "highlight": 0, "resolved": 0}
        if upload_id is not None and warnings:
            try:
                save_preprocessing_warnings(upload_id, warnings)
            except Exception as e:
                log.warning(f"  save_preprocessing_warnings failed (non-fatal): {e}")
        from collections import Counter
        tier_counts = Counter(w.get("tier", TIER_PLAIN) for w in warnings)
        warning_counts = {
            "null":      tier_counts.get(TIER_NULL, 0),
            "highlight": tier_counts.get(TIER_HIGHLIGHT, 0),
            "resolved":  tier_counts.get(TIER_PLAIN, 0),
        }

        # STAGE only — NOT a real write. write_semester_folder() (the
        # actual semester_uploads/longform_uploads commit) is deferred
        # until the user confirms; see confirm-upload in upload_routes.py.
        if upload_id is not None:
            import json
            from util.db_io import stage_semester_upload
            stage_semester_upload(
                upload_id=upload_id,
                academic_year=ay, semester=sem,
                student_csv=student_df.to_csv(index=False),
                longform_csv=long_df.to_csv(index=False),
                student_rows=len(student_df), longform_rows=len(long_df),
                accuracy=accuracy,
                file_hash=file_hash,
                warnings_json=json.dumps(warnings),
            )

        return {
            "success":        True,
            "academic_year":  ay,
            "semester":       sem,
            "student_rows":   len(student_df),
            "longform_rows":  len(long_df),
            "excluded_rows":     info.get("excluded_rows", 0),      # -> uploaded_dataset.excluded_row_count
            "excluded_students": info.get("excluded_students", 0),
            "accuracy":       accuracy,
            "warning_counts": warning_counts,
            "upload_id":      upload_id,
            "error":          None,
        }

    except Exception as e:
        log.exception(f"process_file_v2 failed: {e}")
        return {"success": False, "error": str(e)}


# ══════════════════════════════════════════════════════════════════════════════
#  FEATURE ENGINEERING
# ══════════════════════════════════════════════════════════════════════════════

def engineer_features(df: pd.DataFrame) -> pd.DataFrame:
    """
    From the long-form grade table, compute all per-student aggregates
    used by the ML models.

    GWA: when the table came from the v2 parser it carries the internal
    `_GWA_V2` column (registrar-reported GWA, or the catalog's credit-weighted
    GWA, or a labelled unweighted fallback — see finalize_gwa()). That value
    is authoritative for `GWA`; a student v2 could not compute one for
    (nothing to sum) stays NaN. Avg_Grade / Std_Grade keep their plain
    mean/std over graded subjects, so they can now differ from GWA.
    `_`-prefixed helper columns are dropped from the returned long-form table.
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
            # notna() filters status rows — Grade is NaN for DRP/UDR/W/NGA/INC/CRD/FAILED.
            # Only actual numeric grades (1.00–4.00, 5.00 for FAILED) contribute.
            GWA       = lambda g: g[g.notna()].mean() if g.notna().any() else np.nan,
            Avg_Grade = lambda g: g[g.notna()].mean() if g.notna().any() else np.nan,
            Std_Grade = lambda g: g[g.notna()].std()  if g.notna().sum() > 1 else np.nan,
            Sub_Count = "count",
            Min_Grade = lambda g: g[g.notna()].min() if g.notna().any() else np.nan,
            Max_Grade = lambda g: g[g.notna()].max() if g.notna().any() else np.nan,
        )
        .reset_index()
    )

    # Flags (per student: did they have any of these in this semester?)
    # Use Status column when present (added by _wide_to_legacy_long) for
    # accurate per-status breakdown. Fallback to Grade sentinels for older
    # longform tables that pre-date the Status column.
    if "Status" in df.columns:
        _st_col = df["Status"].fillna("").str.strip().str.upper()
        _df_st  = df.assign(_st=_st_col)
        _AT_RISK = {"FAILED", "INC", "DRP", "UDR", "W", "NGA"}
        flag_df = _df_st.groupby("Student_ID").agg(
            is_inc       = ("_st", lambda g: int(g.isin({"INC","FAILED"}).any())),
            is_drop      = ("_st", lambda g: int(g.isin({"DRP","UDR","W","NGA"}).any())),
            fail_count   = ("_st", lambda g: int(g.isin(_AT_RISK).sum())),
            Failed_Count = ("_st", lambda g: int((g == "FAILED").sum())),
            DRP_Count    = ("_st", lambda g: int((g == "DRP").sum())),
            INC_Count    = ("_st", lambda g: int((g == "INC").sum())),
            UDR_Count    = ("_st", lambda g: int((g == "UDR").sum())),
            W_Count      = ("_st", lambda g: int((g == "W").sum())),
            NGA_Count    = ("_st", lambda g: int((g == "NGA").sum())),
            CRD_Count    = ("_st", lambda g: int((g == "CRD").sum())),
        ).reset_index()
    else:
        # Legacy: no Status column. Grade=NaN means it was a status row
        # (previously 0.0/5.0/-1.0). Cannot distinguish which status.
        flag_df = df.groupby("Student_ID").agg(
            is_inc     = ("Grade", lambda g: int(g.isna().any())),
            is_drop    = ("Grade", lambda g: int(g.isna().any())),
            fail_count = ("Grade", lambda g: int((g.notna() & (g >= 3.0)).sum())),
        ).reset_index()
        for _c in ["Failed_Count","DRP_Count","INC_Count","UDR_Count","W_Count","NGA_Count","CRD_Count"]:
            flag_df[_c] = 0

    student_agg = student_agg.merge(flag_df, on="Student_ID", how="left")

    # v2's GWA (reported / credit-weighted) replaces the plain mean above
    if "_GWA_V2" in df.columns:
        v2_gwa = df.groupby("Student_ID")["_GWA_V2"].first()
        student_agg["GWA"] = student_agg["Student_ID"].map(v2_gwa)

    # Units_Enrolled_Reported / Units_Earned: per-student totals, same
    # value on every subject row for that student -> take .first() per
    # student, same pattern as _GWA_V2 above. Then derive Completion_Rate
    # here so it's stored directly in semester_uploads (student_df) and
    # doesn't have to be reconstructed downstream in separation_csv.py.
    if "Units_Enrolled_Reported" in df.columns:
        units_enrolled = df.groupby("Student_ID")["Units_Enrolled_Reported"].first()
        student_agg["Units_Enrolled_Reported"] = student_agg["Student_ID"].map(units_enrolled)
    if "Units_Earned" in df.columns:
        units_earned = df.groupby("Student_ID")["Units_Earned"].first()
        student_agg["Units_Earned"] = student_agg["Student_ID"].map(units_earned)
    if "Units_Enrolled_Reported" in student_agg.columns and "Units_Earned" in student_agg.columns:
        _valid = (
            student_agg["Units_Enrolled_Reported"].notna()
            & (student_agg["Units_Enrolled_Reported"] > 0)
            & student_agg["Units_Earned"].notna()
        )
        student_agg["Completion_Rate"] = np.where(
            _valid,
            (student_agg["Units_Earned"] / student_agg["Units_Enrolled_Reported"] * 100).round(2),
            np.nan,
        )

    # Derived rate columns
    student_agg["fail_rate"]     = student_agg["fail_count"] / student_agg["Sub_Count"].replace(0, np.nan)
    student_agg["inc_rate"]      = student_agg["is_inc"]  # binary per student
    student_agg["drop_rate"]     = student_agg["is_drop"]
    student_agg["is_irregular"]  = (
        (student_agg["is_inc"] == 1) | (student_agg["is_drop"] == 1)
    ).astype(int)

    helper_cols = [c for c in df.columns if str(c).startswith("_")]
    return student_agg, df.drop(columns=helper_cols)   # aggregated + raw long-form



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
    # just this table re-grouped without Course — no seforte dataset
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
         # Avg_Grade is left out of the accuracy check on purpose: it's None
         # whenever a group had zero completed numeric grades (everyone was
         # DRP/INC/W/UDR/CRD), which is legitimately empty data, not missing
         # data -- counting it here just drags a clean upload's score down
         # to 97-98% for no real reason. Fail_Rate alone reflects whether
         # this dataset's own rows are actually complete.
         accuracy=_pct_valid(subj, ["Fail_Rate"]),
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
#  Two semesters of the same year sit in two completely seforte folders.
#  The only place seforte semesters are ever combined is in memory, at
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
    ⚠ CHANGED: this is now the REAL, permanent commit point. It used to
    be called from process_file_v2() during preprocessing — before the
    user confirmed anything — which meant a cancelled upload had already
    written to the shared tables. process_file_v2() now only STAGES
    (stage_semester_upload(), staged_uploads table); this function is
    called from confirm-upload's _run_separation_and_train() in
    upload_routes.py, loading the staged CSV blobs back into DataFrames
    first. Only call this once the user has actually confirmed.

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
    `by_year_dir` is kept as a formeter only for call-site
    compatibility and is no longer touched.

    `long_df` itself is no longer persisted anywhere by this function —
    only its row count goes into `longform_rows`, same as before.

    `accuracy` is the % of grade cells in this upload that parse_grade()
    successfully resolved to a real grade point, out of every cell
    paired with a subject code (see parse_sheet()'s `stats` form) — a
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
    own CSV blob in a seforte `longform_uploads` table (same
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
    # `by_year_dir` form kept for call-site compatibility but unused now.
    # semester_uploads has one row per (academic_year, semester) upload —
    # COUNT(DISTINCT academic_year) is exactly this, no filesystem scan.
    return count_distinct("semester_uploads", "academic_year")


def count_semesters_with_data(by_year_dir: str) -> int:
    """Total number of individual semester uploads with data — the raw
    upload count, as opposed to count_years_with_data()'s distinct-year
    count. Handy for surfacing '4/6 semesters uploaded' style progress."""
    # `by_year_dir` form kept for call-site compatibility but unused now.
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
    formeter only for call-site compatibility and is no longer touched.

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
    (auto_train) decides sefortely whether enough years now exist to
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
    2026-09-15 migration. `out_dir` is kept as a formeter only so
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