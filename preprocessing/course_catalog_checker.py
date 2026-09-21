"""
course_catalog_checker.py
==========================
Dedicated file for the "Course Code Checker" — a SEPARATE baseline
reference file (Course_Code, Course_Title, Credit_Units) used to:

  1. Verify that every Subject_Code used in the grade file actually
     exists (catch typos / made-up codes / codes that were never
     rolled out yet).
  2. Transform Subject_Code -> Subject_Title (readable names) in the
     grade file's output.
  3. Cross-check Credit_Units between the grade file and the catalog
     (double-checker), and reconcile per-student Credit_Units vs
     Credits_Earned against DRP/INC/W/NGA/UDR statuses.

Order of operations (per your rule — the catalog must prove itself
clean BEFORE it's trusted as a baseline):

    load catalog -> validate catalog ITSELF (nulls, duplicate codes,
    typo'd codes) -> THEN cross-check the grade file against it.

Run standalone just to sanity-check a catalog file on its own:
    python course_catalog_checker.py "Course_Catalog.xlsx"

Normally, though, this is imported and called from preprocess_v2.py
via run_course_code_checks(grade_df, catalog_path, warn).
────────────────────────────────────────────────────────────────────
CATALOG FILE COLUMN ASSUMPTION (adjust CATALOG_COLUMNS below if your
real file uses different header names)
────────────────────────────────────────────────────────────────────
One row per official subject:  Course_Code | Course_Title | Credit_Units
Header names are matched case-insensitively and with spaces/underscores
ignored, so "course code", "Course_Code", "CourseCode" all work.
"""

from __future__ import annotations

import difflib
import re
import sys

import pandas as pd

from warnings_core import WarningCollector

# ── Column-name aliases the catalog loader will recognize ────────────
CATALOG_COLUMNS = {
    "Course_Code":   ["course_code", "coursecode", "subject_code", "subjectcode", "code"],
    "Course_Title":  ["course_title", "coursetitle", "subject_title", "subjectname",
                       "subject_name", "title", "description",
                       # the registrar's own List_of_Courses.xlsx header
                       "descriptivetitle", "descriptive_title"],
    "Credit_Units":  ["credit_units", "creditunits", "units", "credit_unit", "creditunit"],
}

TYPO_CUTOFF_CODE = 0.85   # codes are short, so require a HIGH similarity before flagging
NONPASS_STATUSES = {"DRP", "INC", "UDR", "W", "NGA", "FAILED"}
# CRD = credited. No numeric grade, but the subject was PASSED — it earns
# its credit units like any passing grade.
PASSING_STATUSES = {"CRD"}
# The letters of a code start with a 2-letter program/area tag; whatever
# follows is the TAIL, which tells sibling courses that share a title
# apart (TEAN0223 vs TEAU0223 = two different majors, not a typo).
PROGRAM_PREFIX_LEN = 2
CREDIT_TOLERANCE = 0.01   # float rounding slack when comparing credit-unit totals
GWA_TOLERANCE    = 0.01   # slack when re-deriving a credit-weighted GWA

# Subjects the registrar excludes from the credit-unit totals even
# though the student is enrolled in them and receives a grade. NSTP is
# non-academic and is not counted toward the semester's units.
NON_CREDIT_CODE_PREFIXES = ("NSTP",)

# Highest numeric grade that still earns credit. 4.00 (conditional) and
# 5.00 (failed) earn nothing until the condition is removed.
PASSING_GRADE_MAX = 3.00

# How similar two catalog TITLES must be before a near-identical code
# pair is treated as a typo rather than two distinct subjects. Titles
# are compared after normalising case, spacing, punctuation and "&"/AND,
# so this means "the SAME title" — 0.90 still lets through a stray
# double space, "01" vs "1", or a misspelt word in one of the titles,
# but not two different subjects that merely share some words.
TITLE_SIMILARITY_MIN = 0.90

# Known program tags — the LEADING letters of a course code that say
# which program owns it (CECE0103 = "CE" + "CE", MECE0103 = "ME" + "CE").
# Each program has its own version of the same generic course, so two
# codes that differ ONLY by which of these prefixes they start with are
# two legitimate subjects, not a typo of each other, and are not flagged.
# A prefix that is NOT in this set is still checked the old way, so an
# incomplete list only ever costs extra warnings, never missed typos.
# Seeded from the prefixes seen in the registrar catalog (CE / EC(E) /
# IE / ME / TE, plus HM / TM — their titles literally read "HM ELECTIVE 1"
# vs "TM ELECTIVE 1") — ADD the rest of your program tags here.
KNOWN_PROGRAM_PREFIXES = ("CE", "EC", "IE", "ME", "TE", "HM", "TM")

# How a subject that carries a STATUS instead of a number (INC, DRP, W,
# NGA, UDR) is treated in the credit-weighted GWA:
#   True  -> contributes 0 to Σ(units × grade) but its units stay in
#            Σ(units). This is the convention that reproduces the
#            registrar's own col T numbers, so it is the default.
#   False -> such subjects are left out of numerator AND denominator
#            (the "graded subjects only" reading of the formula).
STATUS_SUBJECTS_COUNT_IN_GWA = True

# GWA_Source label for students who have nothing to sum (see
# mark_no_summable_gwa). Shared with preprocess_v2.finalize_gwa.
NO_SUMMABLE_SOURCE = "MISSING"


def _norm_header(h) -> str:
    return re.sub(r"[^a-z0-9]", "", str(h).strip().lower())


def _to_float(v):
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return None


# ════════════════════════════════════════════════════════════════════
# 1. LOAD + SELF-VALIDATE THE CATALOG  (must be clean BEFORE it's a baseline)
# ════════════════════════════════════════════════════════════════════

def read_catalog_file(path: str) -> pd.DataFrame:
    df = pd.read_excel(path) if path.lower().endswith((".xlsx", ".xls")) else pd.read_csv(path)

    rename_map = {}
    for canonical, aliases in CATALOG_COLUMNS.items():
        for col in df.columns:
            if _norm_header(col) in aliases or _norm_header(col) == _norm_header(canonical):
                rename_map[col] = canonical
                break
    df = df.rename(columns=rename_map)

    missing = [c for c in CATALOG_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(
            f"Course catalog file ay kulang ng column(s): {missing}. "
            f"Kailangan: Course_Code, Course_Title, Credit_Units (anumang katulad na pangalan)."
        )
    return df[["Course_Code", "Course_Title", "Credit_Units"]]


def validate_catalog(raw_df: pd.DataFrame, warn: WarningCollector) -> dict:
    """Returns {code: {"title": ..., "credit_units": ...}} — the CLEAN,
    de-duplicated catalog. Every problem found along the way is added
    to `warn` at top priority (🔴), per the rule that catalog issues
    must surface before the file is trusted as a baseline."""

    # ── null checks ────────────────────────────────────────────────
    for i, row in raw_df.iterrows():
        ref = f"catalog row {i + 2}"  # +2: header row + 0-index offset
        code = row["Course_Code"]
        title = row["Course_Title"]
        units = row["Credit_Units"]
        if pd.isna(code) or str(code).strip() == "":
            warn.add("Null Course Code (Catalog)", "Course_Code is blank in this catalog row", ref)
        if pd.isna(title) or str(title).strip() == "":
            warn.add("Null Course Title (Catalog)", f"No Course_Title for code '{code}'", ref)
        elif pd.notna(code) and str(title).strip().upper() == str(code).strip().upper():
            warn.add(
                "Title = Code lang (Catalog)",
                f"Code '{code}': Course_Title is '{title}' — same as the code, not a real descriptive name. "
                f"Not blank so not caught by the Null Course Title check — "
                f"please verify if this is intentional or should have a proper title.",
                ref,
            )
        if pd.isna(units) or _to_float(units) is None:
            warn.add("Null Credit Units (Catalog)", f"Missing or invalid Credit_Units for code '{code}'", ref)

    clean = raw_df.dropna(subset=["Course_Code"]).copy()
    clean["Course_Code"] = clean["Course_Code"].astype(str).str.strip().str.upper()

    # ── duplicate-code check: harmless exact dupe vs conflicting dupe ─
    catalog: dict = {}
    for code, group in clean.groupby("Course_Code"):
        entries = [
            (str(r["Course_Title"]).strip().upper() if pd.notna(r["Course_Title"]) else None,
             _to_float(r["Credit_Units"]))
            for _, r in group.iterrows()
        ]
        unique_entries = set(entries)
        if len(unique_entries) > 1:
            warn.add(
                "Conflicting Catalog Entry",
                f"Course_Code '{code}' ay may {len(group)} magkakaibang entry sa catalog "
                f"(magkaibang title/credit units: {sorted(unique_entries)}) — hindi malinaw kung "
                f"alin ang tama, kailangan ayusin ang catalog file bago ito gamiting baseline",
                f"catalog code={code}",
            )
        # first occurrence is used as the working value regardless — but the
        # conflict above still gets surfaced so it isn't silently trusted
        title, units = entries[0]
        catalog[code] = {"title": title, "credit_units": units, "display_title": title}

    # ── typo/near-duplicate CODE detection within the catalog ────────
    # A plain similarity score does NOT work on a real course catalog.
    # Sibling codes are supposed to look alike: ACCTG-100 / ACCTG-101 /
    # ACCTG-102, CEST-411 / CEST-412 / CEST-413 are three different
    # subjects each, and every such pair scores well above 0.85. Run
    # that way on the 4,365-row registrar catalog and it emits ~9,500
    # warnings — noise that buries the real problems and trains whoever
    # reviews the modal to skip the whole category.
    #
    # A typo has a SHAPE. In codes of the form LLLLDDDD, the digits are
    # the subject's serial number and the letters are its subject-area
    # tag. Two codes with the SAME digits but letters differing by one
    # character (BTCH0213 vs BTHC0213) are a genuine typo candidate.
    # Different digits means a different subject, not a misspelling.
    # Legacy-format codes (ACCTG-101, CE 323a, ACAD, 140418) are left
    # alone here — their shape carries no reliable signal.
    shaped: dict[str, list[tuple[str, str]]] = {}   # digits -> [(letters, code)]
    for c in catalog:
        m = SHAPED_CODE_RE.match(c)
        if m:
            letters, digits = m.group(1), m.group(2)
            shaped.setdefault(digits, []).append((letters, c))

    flagged_pairs = set()
    for group in shaped.values():
        for i, (l1, c1) in enumerate(group):
            for l2, c2 in group[i + 1:]:
                if (c1, c2) in flagged_pairs or not _one_char_apart(l1, l2):
                    continue
                # Different program, same generic course: both codes
                # start with a KNOWN program tag and the tags differ
                # (CECE0103 vs MECE0103, or the CE/EC swap CECE vs ECCE).
                # That is the curriculum's design, not a mistyping.
                p1, p2 = _program_prefix(l1), _program_prefix(l2)
                if p1 and p2 and p1 != p2:
                    continue
                # Final gate: a real typo produces TWO ROWS FOR THE SAME
                # SUBJECT, so the titles must agree too. Codes that
                # merely share a serial number across departments
                # (HMPE0113 "HM Elective 1" vs EEPE0113 "Power Systems")
                # are different subjects and are not a typo of anything.
                # Same title + one letter off / two letters swapped in
                # the code = a typo, every time.
                t1 = _norm_title(catalog[c1]["title"])
                t2 = _norm_title(catalog[c2]["title"])
                # "THESIS WRITING 1" vs "THESIS WRITING 2" is two subjects,
                # not one subject typed twice: when both titles carry
                # numbers and the numbers differ, it is not a typo.
                n1, n2 = _title_numbers(t1), _title_numbers(t2)
                if n1 and n2 and n1 != n2:
                    continue
                if difflib.SequenceMatcher(None, t1, t2).ratio() < TITLE_SIMILARITY_MIN:
                    continue
                # SAME title, one letter different in the TAIL of the code
                # (after the 2-letter program tag): not a typo. Sibling
                # courses share a title and the tail is what says WHICH
                # course it is (TEAN / TEAU / TEDR ... = the teaching-
                # technology major). Handled by the tail tag below. A
                # SWAP of two letters (MEDM / MEMD), or a difference in
                # the program tag itself, is still a typo candidate.
                kind = _letter_diff(l1, l2)
                if kind and kind[0] == "sub" and kind[1] >= PROGRAM_PREFIX_LEN:
                    continue
                warn.add(
                    "Possible Typo Pair (Catalog)",
                    f"'{c1}' at '{c2}' ay pareho ang digits at isang letra lang ang pagkakaiba "
                    f"({catalog[c1]['title']!r} vs {catalog[c2]['title']!r}) — posibleng typo ng "
                    f"isa't isa. Pareho itong nananatili sa catalog (hindi awtomatikong "
                    f"pinagsasama), pakisuri.",
                    f"catalog codes={c1}/{c2}",
                )
                flagged_pairs.add((c1, c2))

    # ── same-title sibling courses: the code's TAIL says which one ───
    # Several codes can share ONE title and differ only in the tail of
    # their letters (TEAN0223, TEAU0223, TEDR0223 ... all "TECHNOLOGY FOR
    # TEACHING AND LEARNING 2"). The title alone cannot tell them apart,
    # so the tail becomes the marker: Subject_Name reads "<TITLE> [AN]".
    # (Subject_Title_Catalog keeps the plain title.) Codes whose tails
    # are a swap of each other (MEDM/MEMD) are a typo, not siblings.
    for digits, group in shaped.items():
        buckets: dict[tuple, list[tuple[str, str]]] = {}
        for letters, code in group:
            nt = _norm_title(catalog[code]["title"])
            if nt and len(letters) > PROGRAM_PREFIX_LEN:
                buckets.setdefault((letters[:PROGRAM_PREFIX_LEN], nt), []).append((letters, code))
        for (head, nt), members in buckets.items():
            if len(members) < 2:
                continue
            tails = [l[PROGRAM_PREFIX_LEN:] for l, _ in members]
            if any(
                (_letter_diff(t1, t2) or ("", 0))[0] == "swap"
                for i, t1 in enumerate(tails) for t2 in tails[i + 1:]
            ):
                continue
            for letters, code in members:
                catalog[code]["display_title"] = (
                    f"{catalog[code]['title']} [{letters[PROGRAM_PREFIX_LEN:]}]"
                )
            warn.add(
                "Same-title course variants (catalog)",
                f"{len(members)} code na pareho ang title na {catalog[members[0][1]]['title']!r} — "
                f"ang dulo ng code ang palatandaan kung aling course ito: "
                + ", ".join(f"{c} [{l[PROGRAM_PREFIX_LEN:]}]" for l, c in members)
                + ". Hindi ito typo; ginawang Subject_Name ang '<title> [dulo ng code]'.",
                f"catalog codes={'/'.join(c for _, c in members)}",
            )

    return catalog


SHAPED_CODE_RE = re.compile(r"^([A-Z]{2,6})(\d{2,4})$")


def _norm_title(t) -> str:
    """Upper-case, '&' -> AND, punctuation dropped, spaces collapsed —
    so cosmetic differences don't hide two rows for the same subject."""
    t = str(t or "").upper().replace("&", " AND ")
    return re.sub(r"\s+", " ", re.sub(r"[^A-Z0-9]+", " ", t)).strip()


def _title_numbers(t: str) -> list[str]:
    """Numbers in a normalised title, leading zeros ignored ("01" == "1")."""
    return [n.lstrip("0") or "0" for n in re.findall(r"\d+", t)]


def _program_prefix(letters: str) -> str | None:
    """The known program tag a code's letters start with, or None when
    they start with no tag we recognise (longest tag wins)."""
    hits = [p for p in KNOWN_PROGRAM_PREFIXES if letters.startswith(p)]
    return max(hits, key=len) if hits else None


def _letter_diff(a: str, b: str):
    """How two equal-length letter strings differ:
       ("sub", i)  — one substituted letter at position i
       ("swap", i) — letters i and i+1 exchanged
       None        — anything else."""
    if len(a) != len(b):
        return None
    diffs = [i for i, (x, y) in enumerate(zip(a, b)) if x != y]
    if len(diffs) == 1:
        return ("sub", diffs[0])
    if len(diffs) == 2:
        i, j = diffs
        if j == i + 1 and a[i] == b[j] and a[j] == b[i]:
            return ("swap", i)
    return None


def _one_char_apart(a: str, b: str) -> bool:
    """True for the two shapes a real mistyping takes: ONE substituted
    letter (BTCH vs BTCX), or TWO ADJACENT letters swapped (BTCH vs
    BTHC). A transposition differs in two positions, so it has to be
    checked separately — counting differing positions alone would miss
    it, and allowing any two differences would let unrelated codes in."""
    if len(a) != len(b):
        return False
    diffs = [i for i, (x, y) in enumerate(zip(a, b)) if x != y]
    if len(diffs) == 1:
        return True
    if len(diffs) == 2:
        i, j = diffs
        return j == i + 1 and a[i] == b[j] and a[j] == b[i]
    return False


# ════════════════════════════════════════════════════════════════════
# 2. CROSS-CHECK THE GRADE FILE AGAINST THE (now-validated) CATALOG
# ════════════════════════════════════════════════════════════════════

def crosscheck_and_enrich(grade_df: pd.DataFrame, catalog: dict, warn: WarningCollector) -> pd.DataFrame:
    """Adds a Subject_Title_Catalog column (readable title looked up
    from the baseline) and flags any code the grade file uses that the
    catalog doesn't recognize. Unknown codes are NEVER dropped — they
    stay in the dataset, flagged 🟡, exactly per the 'outside-process
    != auto-delete' rule."""
    df = grade_df.copy()
    catalog_codes = list(catalog.keys())

    # PERF FIX: difflib.get_close_matches() is O(len(catalog_codes)) per
    # call. The old loop called it once per ROW of the longform dataframe
    # (one row per subject per student — tens of thousands of rows on a
    # real upload), so the exact same unmatched code (e.g. a recurring
    # typo) triggered the exact same expensive fuzzy-match scan over and
    # over. _fuzzy_cache memoizes "code_u -> matched code or None" so each
    # DISTINCT unmatched code only ever runs difflib once per file, no
    # matter how many student rows carry it.
    _fuzzy_cache: dict[str, str | None] = {}

    resolved_codes = []
    titles = []
    names = []      # Subject_Name: the title, plus the code-tail tag for same-title siblings
    catalog_units = []
    for code in df["Subject_Code"]:
        if code is None or (isinstance(code, float) and pd.isna(code)):
            resolved_codes.append(code)
            titles.append(None)
            names.append(None)
            catalog_units.append(None)
            continue
        code_u = str(code).strip().upper()
        if code_u in catalog:
            resolved_codes.append(code_u)
            titles.append(catalog[code_u]["title"])
            names.append(catalog[code_u]["display_title"])
            catalog_units.append(catalog[code_u]["credit_units"])
            continue
        # typo-correction attempt against the catalog before giving up —
        # cached per distinct code_u (see _fuzzy_cache note above).
        if code_u in _fuzzy_cache:
            match = [_fuzzy_cache[code_u]] if _fuzzy_cache[code_u] else []
        else:
            match = difflib.get_close_matches(code_u, catalog_codes, n=1, cutoff=TYPO_CUTOFF_CODE)
            _fuzzy_cache[code_u] = match[0] if match else None
        if match:
            fixed = match[0]
            warn.add(
                "Typo (Course Code vs Catalog)",
                f"'{code}' → auto-corrected to '{fixed}' based on course catalog",
                f"subject_code={code}",
            )
            resolved_codes.append(fixed)
            titles.append(catalog[fixed]["title"])
            names.append(catalog[fixed]["display_title"])
            catalog_units.append(catalog[fixed]["credit_units"])
        else:
            warn.add(
                "Unknown Course Code (not in catalog)",
                f"'{code}' was not found in the course catalog — title and credit units cannot be verified. "
                f"Row is NOT removed from the dataset; please check if the code is correct "
                f"or needs to be added to the catalog.",
                f"subject_code={code}",
            )
            resolved_codes.append(code_u)
            titles.append(None)
            names.append(None)
            catalog_units.append(None)

    df["Subject_Code"] = resolved_codes
    df["Subject_Title_Catalog"] = titles
    df["Credit_Units_Catalog"] = catalog_units

    # The grade workbook carries no per-subject title or credit units at
    # all — that is the whole reason the catalog exists. Where the grade
    # file left them empty, fill them in from the baseline; where it had
    # its own value, leave it untouched so the mismatch check below still
    # has two independent numbers to compare.
    names = pd.Series(names, index=df.index)
    if "Subject_Name" in df.columns:
        df["Subject_Name"] = df["Subject_Name"].fillna(names)
    else:
        df["Subject_Name"] = names
    if "Credit_Units" in df.columns:
        df["Credit_Units"] = df["Credit_Units"].fillna(df["Credit_Units_Catalog"])
    else:
        df["Credit_Units"] = df["Credit_Units_Catalog"]

    # ── per-subject credit-unit mismatch (grade file vs catalog) ─────
    # PERF FIX: was a plain `for idx, row in df.iterrows()` over the WHOLE
    # longform dataframe just to compare two numbers per row — the
    # classic slow pandas anti-pattern. Vectorized: compute both numeric
    # columns once, build a boolean mask, then only loop over the (much
    # smaller) subset of rows that actually mismatch.
    cu_file_num = pd.to_numeric(
        df["Credit_Units"].map(_to_float) if "Credit_Units" in df.columns else pd.Series(dtype=float),
        errors="coerce",
    )
    cu_cat_num = pd.to_numeric(df.get("Credit_Units_Catalog"), errors="coerce")
    mismatch_mask = (
        cu_file_num.notna() & cu_cat_num.notna()
        & ((cu_file_num - cu_cat_num).abs() > CREDIT_TOLERANCE)
    )
    if mismatch_mask.any():
        for idx, row in df.loc[mismatch_mask, ["Subject_Code"]].iterrows():
            warn.add(
                "Credit Units mismatch vs Catalog",
                f"'{row['Subject_Code']}': grade file={cu_file_num.loc[idx]} "
                f"but catalog={cu_cat_num.loc[idx]} — values do not match",
                f"row {idx}",
            )

    return df


# ════════════════════════════════════════════════════════════════════
# 2b. PER-SUBJECT CREDITS EARNED
# ════════════════════════════════════════════════════════════════════

def fill_credits_earned(df: pd.DataFrame) -> pd.DataFrame:
    """Fills Credits_Earned per subject, ONLY where credit was really
    earned:

      • passed (numeric grade <= 3.00)  -> the catalog's credit units.
                                           The GRADE decides, for every
                                           subject — NSTP included, and
                                           a "INC/2.75" slash grade counts
                                           as its resolved 2.75.
      • credited (status CRD)           -> the catalog's credit units
      • failed (4.00 / 5.00), no grade, or a status (INC/DRP/W/NGA/UDR)
                                        -> left NULL

    The NULL is deliberate: it is the user's cue that nothing was earned
    on that row, without needing a separate flag. (It also stays NULL if
    the subject's code isn't in the catalog, since its units are unknown
    — that case is already flagged as Unknown Course Code.)

    A Credits_Earned value the grade file already carried is kept as-is.
    """
    grade = pd.to_numeric(df["Grade"], errors="coerce")
    units = pd.to_numeric(df["Credit_Units"], errors="coerce")
    passed = (grade.notna() & (grade <= PASSING_GRADE_MAX)) | df["Status"].isin(PASSING_STATUSES)
    computed = units.where(passed)

    if "Credits_Earned" in df.columns:
        existing = pd.to_numeric(df["Credits_Earned"], errors="coerce")
        df["Credits_Earned"] = existing.combine_first(computed)
    else:
        df["Credits_Earned"] = computed
    return df


# ════════════════════════════════════════════════════════════════════
# 2c. COLLEGE GWA — Philippine standard credit-weighted formula
# ════════════════════════════════════════════════════════════════════

def compute_college_gwa(units: pd.Series, grades: pd.Series) -> float | None:
    """GWA = Σ(units × grade) / Σ(units)

    `units` and `grades` are aligned per-subject Series, already limited
    to the subjects that count toward the load (NSTP excluded). A grade
    of NaN means the subject carried a status rather than a number; how
    that is treated is set by STATUS_SUBJECTS_COUNT_IN_GWA. Returns None
    when there is no numeric grade at all — a GWA can't be derived from
    zero grades, and 0.0 would be a fabricated value, not a result.
    """
    u = pd.to_numeric(units, errors="coerce")
    g = pd.to_numeric(grades, errors="coerce")
    has_grade = g.notna()
    if not has_grade.any():
        return None
    if STATUS_SUBJECTS_COUNT_IN_GWA:
        denom = u.sum()
        numer = (u * g.fillna(0)).sum()
    else:
        denom = u[has_grade].sum()
        numer = (u[has_grade] * g[has_grade]).sum()
    return float(numer / denom) if denom > 0 else None


def mark_no_summable_gwa(df: pd.DataFrame, index, who: str, warn: WarningCollector, ref: str):
    """A student with no numeric grade to sum (all DRP/INC/W/NGA/UDR or
    blank — i.e. failed/dropped nearly everything) legitimately ends up
    with no summable GWA: the formula has nothing to add up. GWA is set to
    None (shown as MISSING via GWA_Source) so the dashboard can tell them
    apart from students with a real computed or reported GWA. The student
    stays in the dataset and in training."""
    df.loc[index, "GWA"] = None
    df.loc[index, "GWA_Source"] = NO_SUMMABLE_SOURCE
    warn.add(
        "GWA not summable (all failed/status)",
        f"Student '{who}': no numeric grades to sum (all FAILED/DRP/INC/W/NGA/UDR or blank) — "
        f"GWA is MISSING. Student is kept in the dataset and flagged for the dashboard.",
        ref,
    )


# ════════════════════════════════════════════════════════════════════
# 3. DUPLICATE SUBJECT WITHIN ONE STUDENT  (before trusting the catalog crosscheck)
# ════════════════════════════════════════════════════════════════════

def check_duplicate_subjects_per_student(df: pd.DataFrame, warn: WarningCollector):
    """Same Subject_Code appearing twice under the SAME Student_ID —
    almost always a data-entry duplication (the whole row got pasted
    twice), not two legitimate enrollments. Flagged at top priority;
    does NOT auto-remove either row (per the outside-process rule) —
    a human should decide which one (if either) is the real entry."""
    if "Student_ID" not in df.columns:
        return
    for student_id, group in df.groupby("Student_ID"):
        if student_id is None:
            continue
        dupes = group[group["Subject_Code"].duplicated(keep=False)]
        for code, sub in dupes.groupby("Subject_Code"):
            warn.add(
                "Duplicate Subject (same student)",
                f"Student '{student_id}' has Subject_Code '{code}' appearing "
                f"{len(sub)}x in the same record — possible duplicate row entry",
                f"student={student_id} subject={code}",
            )


# ════════════════════════════════════════════════════════════════════
# 4. CREDIT-UNIT RECONCILIATION  (the "double checker")
# ════════════════════════════════════════════════════════════════════

def reconcile_credit_units(df: pd.DataFrame, warn: WarningCollector):
    """Three reconciliations, all per student, all against the registrar's
    OWN totals as printed in the grade sheet (cols R/S/T).

    This is the replacement for a per-subject comparison, which cannot
    run on this workbook: the grade sheet has no per-subject Credit_Units
    or Credits_Earned column to compare against. What it does have is a
    per-student TOTAL, and the catalog can rebuild that total from the
    subject codes — which is a stronger check anyway, because it catches
    a wrong subject code even when every number on the row looks fine.

    (A) Units enrolled — sum of catalog units for the student's subjects
        vs the sheet's reported total.

    (B) Units earned — the same sum minus whatever the student's
        DRP/INC/W/NGA/UDR subjects were worth. Those subjects still
        count toward the load enrolled but contribute 0 to units earned,
        so a shortfall that exactly matches them is NORMAL and is not
        warned about; only an unexplained difference is flagged.

    (C) GWA — recomputed credit-weighted from the catalog units. If the
        sheet's GWA is blank/0 the computed value FILLS it (GWA and
        GWA_Source columns are updated in `df`); if the sheet has a GWA,
        the computed value is CHECKED against it.

    Mutates and returns `df`.
    """
    if "Student_ID" not in df.columns:
        return df

    for student_id, group in df.groupby("Student_ID"):
        if student_id is None:
            continue
        ref = f"student={student_id}"

        cat_units = group["Credit_Units_Catalog"].apply(_to_float)
        known = cat_units.notna()
        if not known.any():
            continue   # nothing the catalog recognises; already flagged per-code

        # Subjects the registrar does not count toward credit units at
        # all (NSTP is non-academic). Including them makes ~2,400
        # students in one semester look like they are off by exactly
        # 3.0 units, which is not a data error — it is the wrong rule.
        counted = known & ~group["Subject_Code"].astype(str).str.upper().str.startswith(
            tuple(NON_CREDIT_CODE_PREFIXES)
        )

        expected_enrolled = cat_units[counted].sum()
        nonpass = group["Status"].isin(NONPASS_STATUSES)

        # Credits are earned only where the subject was actually PASSED.
        # A DRP/INC/W/NGA/UDR earns nothing — but so does a failing
        # numeric grade, and that second case is the larger one: treating
        # every graded subject as earned leaves ~1,100 students looking
        # wrong in 2022-1, and 913 of them have no status keyword at all,
        # just a 5.00. Restricting to passing grades brings it to 157.
        numeric = group["Grade"].apply(_to_float)
        passed = (numeric.notna() & (numeric <= PASSING_GRADE_MAX)) \
            | group["Status"].isin(PASSING_STATUSES)
        expected_earned = cat_units[counted & passed].sum()

        # ── (A) units enrolled ────────────────────────────────────────
        reported_enrolled = _to_float(group["Units_Enrolled_Reported"].iloc[0]) \
            if "Units_Enrolled_Reported" in group.columns else None
        if reported_enrolled is not None and not known.all():
            pass   # incomplete catalog coverage would skew the total; skip
        elif reported_enrolled is not None and abs(expected_enrolled - reported_enrolled) > CREDIT_TOLERANCE:
            warn.add(
                "Credit Units total mismatch vs Catalog",
                f"Student '{student_id}': catalog says enrolled units should be "
                f"{expected_enrolled} but sheet reports {reported_enrolled} — "
                f"mismatch (possible wrong subject code or incorrect total)",
                ref,
            )

        # ── (B) units earned ──────────────────────────────────────────
        reported_earned = _to_float(group["Units_Earned_Reported"].iloc[0]) \
            if "Units_Earned_Reported" in group.columns else None
        if reported_earned is not None and pd.isna(reported_earned):
            reported_earned = None      # a blank cell reads back as NaN, not None

        if known.all():
            shortfall = expected_earned - (reported_earned or 0.0)
            if reported_earned is None or shortfall > CREDIT_TOLERANCE:
                # The sheet's total is blank, or SHORTER than what the
                # student's own grades add up to (the registrar left it
                # unencoded / partly encoded — 0 units earned next to a
                # row of passing grades, for example). The grades are the
                # checker AND the source of truth: a subject with a
                # passing grade was earned. A slash grade such as
                # INC/2.75 is already resolved to its updated 2.75 in
                # Grade, so it counts. NSTP stays out of the total,
                # same as the sheet's own totals.
                df.loc[group.index, "Units_Earned"] = expected_earned
                df.loc[group.index, "Units_Earned_Source"] = (
                    "Computed (from grades)" if reported_earned is None
                    else "Computed (from grades; sheet total was short)"
                )
                sheet_txt = "no total credit units earned in sheet" if reported_earned is None \
                    else f"only {reported_earned} units earned reported in sheet"
                warn.add(
                    "Credits Earned (computed from grades)",
                    f"Student '{student_id}': {sheet_txt}, but {expected_earned} units of passing-grade "
                    f"subjects found — computed value used: "
                    f"Units_Earned={expected_earned} (original kept in Units_Earned_Reported)",
                    ref,
                )
            elif -shortfall > CREDIT_TOLERANCE:
                # The reverse: the sheet claims MORE than the grades
                # support. Nothing to add from the grades — flag it.
                warn.add(
                    "Credits Earned mismatch",
                    f"Student '{student_id}': sheet reports {reported_earned} units earned but only "
                    f"{expected_earned} are supported by passing grades (excluding "
                    f"{int(nonpass.sum())} DRP/INC/W/NGA/UDR/FAILED subjects) — "
                    f"sheet total is higher than what grades support",
                    ref,
                )

        # ── (C) credit-weighted GWA: FILL when empty, CHECK when present ──
        # Formula (Philippine college standard, see compute_college_gwa):
        #
        #     GWA = Σ(units × grade) / Σ(units)
        #
        # Only run when EVERY subject of the student is in the catalog —
        # a partial unit list would produce a wrong GWA, and we'd rather
        # say nothing (the unknown code is already flagged) than write
        # or accuse on a number we know is incomplete.
        reported_gwa = _to_float(group["GWA_Reported"].iloc[0]) \
            if "GWA_Reported" in group.columns else None
        if reported_gwa is not None and pd.isna(reported_gwa):
            reported_gwa = None      # a blank cell reads back as NaN, not None
        if not known.all():
            continue
        gwa_empty = reported_gwa is None or reported_gwa <= 0
        # For GWA: 5.00 (failed) was converted to DRP status so Grade=None,
        # but the registrar computed GWA using 5.00 as a number in the
        # weighted sum. Restore the raw 5.00 values for GWA purposes only —
        # Credits_Earned is still NULL (failed = nothing earned).
        raw_5 = group["Grade_Raw"].apply(_to_float).apply(
            lambda v: v if v == 5.0 else None
        )
        gwa_numeric = numeric[counted].combine_first(raw_5[counted])
        weighted = compute_college_gwa(cat_units[counted], gwa_numeric)
        if weighted is None:
            # Nothing to sum: every counted subject is a status or has no
            # grade (the student failed/dropped nearly everything). That
            # is a correct outcome, not a data error — just identify them.
            if gwa_empty:
                mark_no_summable_gwa(df, group.index, str(student_id), warn, ref)
            continue

        if gwa_empty:
            # Blank or 0 — a real GWA is never below 1.00, so 0 means the
            # cell was never filled in. Derive it from the grades instead.
            df.loc[group.index, "GWA"] = round(weighted, 5)
            df.loc[group.index, "GWA_Source"] = "Computed (credit-weighted)"
            if reported_gwa is None:
                warn.add(
                    "GWA computed from grades",
                    f"Student '{student_id}': no GWA in col T — computed from grades "
                    f"using credit-weighted formula: {round(weighted, 4)}",
                    ref,
                )
            else:
                warn.add(
                    "GWA is 0 in sheet but grades exist",
                    f"Student '{student_id}': GWA is 0 in col T but actual grades exist — "
                    f"computed from grades using credit-weighted formula: "
                    f"{round(weighted, 4)}",
                    ref,
                )
        elif abs(weighted - reported_gwa) > GWA_TOLERANCE:
            # Checker: the grades we extracted do not reproduce the
            # registrar's GWA. When the unit totals ALSO disagree (A),
            # say so in the message rather than hiding the GWA problem —
            # it is probably the same root cause, but it is still a
            # mismatch the user should see.
            also_units = (
                " (this student also has a units mismatch — likely the same root cause)"
                if reported_enrolled is not None
                and abs(expected_enrolled - reported_enrolled) > CREDIT_TOLERANCE
                else ""
            )
            warn.add(
                "GWA mismatch vs Catalog",
                f"Student '{student_id}': sheet GWA={round(reported_gwa, 4)} but "
                f"{round(weighted, 4)} ang credit-weighted na kalkulasyon mula sa mga grade "
                f"gamit ang catalog units — hindi tugma, pakisuri{also_units}",
                ref,
            )

    return df


# ════════════════════════════════════════════════════════════════════
# ENTRYPOINT — called from preprocess_v2.py
# ════════════════════════════════════════════════════════════════════

def run_course_code_checks(grade_df: pd.DataFrame, catalog_path: str, warn: WarningCollector) -> pd.DataFrame:
    """Full pipeline: load+validate catalog -> duplicate-subject check
    -> cross-check/enrich grade file -> per-subject Credits_Earned ->
    credit-unit + GWA reconciliation (fills a blank/0 GWA, checks the rest).
    Returns the ENRICHED grade dataframe (Subject_Title_Catalog,
    Credit_Units_Catalog columns added). Never removes rows."""
    print(f"\n⏳ Checking course catalog: {catalog_path}")
    raw_catalog = read_catalog_file(catalog_path)
    catalog = validate_catalog(raw_catalog, warn)
    print(f"   {len(catalog)} unique course code(s) in catalog (after deduplication).")

    check_duplicate_subjects_per_student(grade_df, warn)

    enriched = crosscheck_and_enrich(grade_df, catalog, warn)
    enriched = fill_credits_earned(enriched)
    enriched = reconcile_credit_units(enriched, warn)
    return enriched


# ── standalone runner: sanity-check just the catalog file on its own ──
if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python course_catalog_checker.py <path-to-catalog-file>")
        sys.exit(1)
    w = WarningCollector()
    raw = read_catalog_file(sys.argv[1])
    cat = validate_catalog(raw, w)
    print(f"{len(cat)} unique course code(s) loaded.")
    w.print_modal()