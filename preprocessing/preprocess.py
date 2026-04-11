import pandas as pd
from sklearn.preprocessing import MinMaxScaler
import os

# ── Configuration ─────────────────────────────────────────────────────────────

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

# Non-subject columns — everything else is a subject grade
META_COLS = {"student", "gender", "status", "gwa"}

# ── Helpers ───────────────────────────────────────────────────────────────────

def clean_col(col: str) -> str:
    """Strip whitespace and newlines from a column name."""
    return col.strip().replace("\n", " ").strip()


def find_col(df: pd.DataFrame, candidates: list) -> str:
    """Return the first df column whose cleaned lower matches any candidate."""
    lowered = {clean_col(c).lower(): c for c in df.columns}
    for cand in candidates:
        if cand.lower() in lowered:
            return lowered[cand.lower()]
    return None


def parse_sheet_name(sheet_name: str) -> tuple:
    """'CCST_1yr_1sem' -> ('CCST', '1sem')"""
    parts = sheet_name.strip().split("_")
    college  = parts[0]
    semester = parts[-1].strip()
    return college, semester


# ── Core per-sheet processing ─────────────────────────────────────────────────

def preprocess_sheet(raw_df: pd.DataFrame, sheet_name: str, year: str) -> pd.DataFrame:
    df = raw_df.copy()
    college, semester = parse_sheet_name(sheet_name)

    # Normalize all column names (strip whitespace / newlines)
    df.columns = [clean_col(c) for c in df.columns]

    # Identify key columns (tolerant of typos & casing)
    student_col = find_col(df, ["Student", "Student_ID", "StudentID", "Stud_ID"])
    gender_col  = find_col(df, ["Gender", "Sex"])
    status_col  = find_col(df, ["Status", "status", "Stutus", "STATUS",
                                 "Column 12", "Column 15"])
    gwa_col     = find_col(df, ["GWA", "General Weighted Average", "Weighted Average"])

    if student_col is None:
        print(f"    [SKIP] No Student column found in '{sheet_name}'")
        return pd.DataFrame()

    # Rename to standard names
    rename = {}
    if student_col: rename[student_col] = "Student_ID"
    if gender_col:  rename[gender_col]  = "Gender"
    if status_col:  rename[status_col]  = "Status"
    if gwa_col:     rename[gwa_col]     = "GWA"
    df = df.rename(columns=rename)

    # Ensure Status column exists
    if "Status" not in df.columns:
        df["Status"] = "Unknown"
        print(f"    [Status]  Column not found — filled with 'Unknown'")

    # Cast Student_ID to string
    df["Student_ID"] = df["Student_ID"].astype(str).str.strip()

    # Identify subject columns (everything that is not a meta column)
    subject_cols = [
        c for c in df.columns
        if c.lower() not in META_COLS and c not in ("Student_ID", "Gender", "Status", "GWA")
    ]

    # MELT: wide -> long (one row per student per subject)
    id_vars = [c for c in ["Student_ID", "Gender", "Status", "GWA"] if c in df.columns]

    df_long = df[id_vars + subject_cols].melt(
        id_vars=id_vars,
        var_name="Course_Subject_Name",
        value_name="Grade",
    )

    # Clean up subject names
    df_long["Course_Subject_Name"] = df_long["Course_Subject_Name"].str.strip()

    # 1. Fill missing Grade with 0 for INC / Drop rows
    if "Status" in df_long.columns:
        mask = df_long["Status"].isin(["INC", "Drop"]) & df_long["Grade"].isna()
        filled = mask.sum()
        df_long.loc[mask, "Grade"] = 0
        if filled:
            print(f"    [Grade fill]  Filled {filled} Grade(s) for INC/Drop rows")

    # Drop rows where Grade is still NaN
    df_long = df_long.dropna(subset=["Grade"])

    # 2. Remove duplicate Student + Subject rows (keep first)
    before = len(df_long)
    df_long = df_long.drop_duplicates(
        subset=["Student_ID", "Course_Subject_Name"], keep="first"
    )
    removed = before - len(df_long)
    if removed:
        print(f"    [Duplicates]  Removed {removed} duplicate Student+Subject row(s)")

    # 3. Encode Gender: Male -> 0, Female -> 1
    if "Gender" in df_long.columns:
        df_long["Gender"] = df_long["Gender"].map({"Male": 0, "Female": 1})

    # 4. Add College, Semester & Year
    df_long["College"]  = college
    df_long["Semester"] = semester
    df_long["Year"]     = year

    # 5. Min-Max scale GWA to (900, 1000), excluding 0-GWA (INC/Drop)
    if "GWA" in df_long.columns:
        valid = df_long["GWA"].notna() & (df_long["GWA"] != 0)
        if valid.sum() > 1:
            scaler = MinMaxScaler(feature_range=(900, 1000))
            df_long.loc[valid, "GWA"] = scaler.fit_transform(
                df_long.loc[valid, "GWA"].values.reshape(-1, 1)
            ).flatten()
            print(f"    [GWA scale]   Scaled {valid.sum()} GWA values to range (900-1000)")

    # Return only required final columns that exist
    existing = [c for c in FINAL_COLUMNS if c in df_long.columns]
    return df_long[existing].reset_index(drop=True)


# ── Per-file processing ───────────────────────────────────────────────────────

def process_file(filepath: str, year: str) -> pd.DataFrame:
    all_sheets = pd.read_excel(filepath, sheet_name=None)
    frames = []

    for sheet_name, df in all_sheets.items():
        print(f"\n  Sheet '{sheet_name}' — {len(df)} raw rows")
        try:
            cleaned = preprocess_sheet(df, sheet_name, year)
            frames.append(cleaned)
            print(f"  OK: {len(cleaned)} long-format rows after preprocessing")
        except Exception as e:
            print(f"  SKIP '{sheet_name}' — {e}")

    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


# ── Main pipeline ─────────────────────────────────────────────────────────────

def main():
    os.makedirs(PROCESSED_DIR, exist_ok=True)
    print(f"Saving cleaned files to: '{PROCESSED_DIR}/'")

    all_dfs = []

    for key, filename in FILES.items():
        if not os.path.exists(filename):
            print(f"\n[WARN] File not found, skipping: {filename}")
            continue

        print(f"\n{'='*60}")
        print(f"Processing: {filename}")
        print(f"{'='*60}")

        df_cleaned = process_file(filename, key)

        out_path = os.path.join(PROCESSED_DIR, OUTPUT_CSVs[key])
        df_cleaned.to_csv(out_path, index=False)
        print(f"\n  Saved: {out_path}  ({len(df_cleaned):,} rows)")
        all_dfs.append(df_cleaned)

    # Merge all three cleaned files into master CSV
    print(f"\n{'='*60}")
    if all_dfs:
        df_final = pd.concat(all_dfs, ignore_index=True)
        final_cols = [c for c in FINAL_COLUMNS if c in df_final.columns]
        df_final = df_final[final_cols]
        df_final.to_csv(FINAL_OUTPUT, index=False)

        print(f"Final merged file: '{FINAL_OUTPUT}'  ({len(df_final):,} rows)")
        print(f"\n--- Summary ---")
        print(f"Columns      : {list(df_final.columns)}")
        print(f"Gender counts:\n{df_final['Gender'].value_counts().to_string()}")
        print(f"\nStatus counts:\n{df_final['Status'].value_counts().to_string()}")
        print(f"\nCollege counts:\n{df_final['College'].value_counts().to_string()}")
        print(f"\nGWA range    : {df_final['GWA'].min():.2f} - {df_final['GWA'].max():.2f}")
    else:
        print("[ERROR] No data processed. Make sure Excel files are in the same folder.")


if __name__ == "__main__":
    main()