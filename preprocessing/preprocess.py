import pandas as pd
import os

# ── Configuration ─────────────────────────────────────────────

FILES = {
    "2022-2023": "datasets/Student 2022-2023.xlsx",
    "2023-2024": "datasets/Student 2023-2024.xlsx",
    "2024-2025": "datasets/Student 2024-2025.xlsx",
}

OUTPUT_CSVs = {
    "2022-2023": "2022_2023_cleaned.csv",
    "2023-2024": "2023_2024_cleaned.csv",
    "2024-2025": "2024_2025_cleaned.csv",
}

FINAL_COLUMNS = [
    "Student_ID", "Gender", "Status",
    "Course_Subject_Name", "Grade", "GWA",
    "Semester", "College", "Year",
]

PROCESSED_DIR = "processed_datasets"
FINAL_OUTPUT = os.path.join(PROCESSED_DIR, "Final_Merged_Student_Data.csv")

GRADE_INC  = 5
GRADE_DROP = 0

META_COLS = {"student", "gender", "status", "gwa"}

# ── Helpers ─────────────────────────────────────────────────

def clean_col(col: str) -> str:
    return col.strip().replace("\n", " ").strip()

def find_col(df: pd.DataFrame, candidates: list) -> str:
    lowered = {clean_col(c).lower(): c for c in df.columns}
    for cand in candidates:
        if cand.lower() in lowered:
            return lowered[cand.lower()]
    return None

# Status Normalization
def normalize_status(status: str) -> str:
    if pd.isna(status):
        return "REGULAR"

    s = str(status).strip().upper()

    if "INC" in s or "INCOMPLETE" in s:
        return "INC"
    elif "DROP" in s or "DRP" in s or "DROPPED" in s:
        return "DROP"
    else:
        return "REGULAR"

def parse_sheet_name(sheet_name: str) -> tuple:
    parts = sheet_name.strip().split("_")
    college  = parts[0]
    semester = parts[-1].strip()
    year_level = "Y1"

    for part in parts:
        p = part.lower()
        if "1yr" in p or "yr1" in p or "1st" in p:
            year_level = "Y1"
        elif "2yr" in p or "yr2" in p or "2nd" in p:
            year_level = "Y2"
        elif "3yr" in p or "yr3" in p or "3rd" in p:
            year_level = "Y3"
        elif "4yr" in p or "yr4" in p or "4th" in p:
            year_level = "Y4"

    return college, semester, year_level

# ── Core processing ─────────────────────────────────────────

def preprocess_sheet(raw_df: pd.DataFrame, sheet_name: str, year: str) -> pd.DataFrame:
    df = raw_df.copy()
    college, semester, year_level = parse_sheet_name(sheet_name)

    df.columns = [clean_col(c) for c in df.columns]

    student_col = find_col(df, ["Student", "Student_ID", "StudentID", "Stud_ID"])
    gender_col  = find_col(df, ["Gender", "Sex"])
    status_col  = find_col(df, ["Status", "Stutus", "Column 12", "Column 15"])
    gwa_col     = find_col(df, ["GWA", "General Weighted Average", "Weighted Average"])

    if student_col is None:
        print(f"    [SKIP] No Student column in '{sheet_name}'")
        return pd.DataFrame()

    rename = {}
    if student_col: rename[student_col] = "Student_ID"
    if gender_col:  rename[gender_col]  = "Gender"
    if status_col:  rename[status_col]  = "Status"
    if gwa_col:     rename[gwa_col]     = "GWA"

    df = df.rename(columns=rename)

    if "Status" not in df.columns:
        df["Status"] = "REGULAR"

    # APPLY NORMALIZATION HERE
    df["Status"] = df["Status"].apply(normalize_status)

    # Normalize other fields
    df["Student_ID"] = df["Student_ID"].astype(str).str.strip()

    if "Gender" in df.columns:
        df["Gender"] = df["Gender"].astype(str).str.strip().str.capitalize()

    # Unique Student ID
    df["Student_ID"] = (
        df["Student_ID"]
        + college
        + year_level
        + year.replace("-", "")
    )

    # Subject columns
    subject_cols = [
        c for c in df.columns
        if c.lower() not in META_COLS and c not in ("Student_ID", "Gender", "Status", "GWA")
    ]

    id_vars = [c for c in ["Student_ID", "Gender", "Status", "GWA"] if c in df.columns]

    # Melt wide → long
    df_long = df[id_vars + subject_cols].melt(
        id_vars=id_vars,
        var_name="Course_Subject_Name",
        value_name="Grade",
    )

    df_long["Course_Subject_Name"] = df_long["Course_Subject_Name"].str.strip()
    df_long["Grade"] = pd.to_numeric(df_long["Grade"], errors="coerce")

    # CLEAN SENTINEL LOGIC
    inc_mask  = (df_long["Status"] == "INC") & df_long["Grade"].isna()
    drop_mask = (df_long["Status"] == "DROP") & df_long["Grade"].isna()

    df_long.loc[inc_mask,  "Grade"] = GRADE_INC
    df_long.loc[drop_mask, "Grade"] = GRADE_DROP

    print(f"    [INC  filled] {inc_mask.sum()}")
    print(f"    [Drop filled] {drop_mask.sum()}")

    # Drop unknown
    still_missing = df_long["Grade"].isna().sum()
    if still_missing:
        print(f"    [Dropped NaN] {still_missing}")
    df_long = df_long.dropna(subset=["Grade"])

    # ── Dedup Fix ───────────────────────────────────────────

    is_drop_sentinel = df_long["Grade"] == GRADE_DROP

    real_rows = df_long[~is_drop_sentinel].copy()
    drop_rows = df_long[is_drop_sentinel].copy()

    real_rows = real_rows.sort_values("Grade", ascending=True)
    real_rows = real_rows.drop_duplicates(
        subset=["Student_ID", "Course_Subject_Name"], keep="first"
    )

    covered = set(zip(real_rows["Student_ID"], real_rows["Course_Subject_Name"]))

    drop_rows = drop_rows[
        ~drop_rows.apply(
            lambda r: (r["Student_ID"], r["Course_Subject_Name"]) in covered,
            axis=1
        )
    ]

    drop_rows = drop_rows.drop_duplicates(
        subset=["Student_ID", "Course_Subject_Name"], keep="first"
    )

    df_long = pd.concat([real_rows, drop_rows], ignore_index=True)

    print(f"    [Dedup] Real: {len(real_rows)} | Drop kept: {len(drop_rows)}")

    # Encode Gender
    if "Gender" in df_long.columns:
        df_long["Gender"] = df_long["Gender"].map({"Male": 0, "Female": 1})

    # Metadata
    df_long["College"]  = college
    df_long["Semester"] = semester
    df_long["Year"]     = year

    # ── GWA FIX ───────────────────────────────────────────

    if "GWA" in df_long.columns:
        df_long["GWA"] = pd.to_numeric(df_long["GWA"], errors="coerce").fillna(0)

        def fix_gwa(group):
            gwa_val = group["GWA"].iloc[0]
            status  = group["Status"].iloc[0]

            if gwa_val == 0 and status == "INC":
                grades = group.loc[
                    ~group["Grade"].isin([GRADE_DROP, GRADE_INC]), "Grade"
                ]
                if len(grades) > 0:
                    group = group.copy()
                    group["GWA"] = round(grades.mean(), 2)

            return group

        df_long = df_long.groupby("Student_ID", group_keys=False).apply(fix_gwa)

    existing = [c for c in FINAL_COLUMNS if c in df_long.columns]
    return df_long[existing].reset_index(drop=True)

# ── File processing ─────────────────────────────────────────

def process_file(filepath: str, year: str) -> pd.DataFrame:
    sheets = pd.read_excel(filepath, sheet_name=None)
    frames = []

    for name, df in sheets.items():
        print(f"\n  Sheet: '{name}'")
        try:
            cleaned = preprocess_sheet(df, name, year)
            frames.append(cleaned)
            print(f"  OK → {len(cleaned):,} rows")
        except Exception as e:
            print(f"  ERROR → {e}")

    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()

# ── Main ───────────────────────────────────────────────────

def main():
    os.makedirs(PROCESSED_DIR, exist_ok=True)

    all_dfs = []

    for year, path in FILES.items():
        if not os.path.exists(path):
            print(f"[Missing] {path}")
            continue

        print(f"\n{'='*60}")
        print(f"Processing: {path}")
        print(f"{'='*60}")

        df = process_file(path, year)

        out = os.path.join(PROCESSED_DIR, OUTPUT_CSVs[year])
        df.to_csv(out, index=False)
        print(f"\n  Saved → {out}  ({len(df):,} rows)")
        all_dfs.append(df)

    if all_dfs:
        final = pd.concat(all_dfs, ignore_index=True)
        final = final[[c for c in FINAL_COLUMNS if c in final.columns]]

        if "GWA" in final.columns:
            final["GWA"] = final["GWA"].round(2)

        final.to_csv(FINAL_OUTPUT, index=False)

        print(f"\n{'='*60}")
        print(f"FINAL DATASET: {FINAL_OUTPUT}  ({len(final):,} rows)")
        print(f"\nINC  rows:  {(final['Status'] == 'INC').sum():,}")
        print(f"Drop rows: {(final['Status'] == 'DROP').sum():,}")
        print(f"\nStatus counts:\n{final['Status'].value_counts()}")

if __name__ == "__main__":
    main()