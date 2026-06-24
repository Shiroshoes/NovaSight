import pandas as pd
import numpy as np
import os

# ==========================
# CONFIGURATION
# ==========================

NON_SUBJECT_COLUMNS = [
    'Student_ID',
    'Student Number',
    'Name',
    'Gender',
    'Program',
    'Course',
    'Year_Level',
    'Semester',
    'School_Year',
    'GWA'
]

# ==========================
# HELPER FUNCTIONS
# ==========================

def is_subject_column(column_name):
    """
    Detect if a column is a subject code.
    Example:
        EGEC0103
        ARPC2212
        ITCC2201
    """
    return column_name not in NON_SUBJECT_COLUMNS


def convert_grade(grade):
    """
    Convert grade text into numeric.
    """

    if pd.isna(grade):
        return np.nan

    grade = str(grade).strip().upper()

    if grade == 'INC':
        return np.nan

    if grade == 'DRP':
        return np.nan

    if grade == 'W':
        return np.nan

    try:
        return float(grade)
    except:
        return np.nan


# ==========================
# MAIN CONVERTER
# ==========================

def convert_excel(file_path):

    print(f"\nReading: {file_path}")

    df = pd.read_excel(file_path)

    # --------------------------
    # Detect Subject Columns
    # --------------------------

    subject_columns = [
        col for col in df.columns
        if is_subject_column(col)
    ]

    print(f"Detected {len(subject_columns)} subject columns")

    # --------------------------
    # DATASET 1:
    # Student Summary
    # --------------------------

    summary_rows = []

    # --------------------------
    # DATASET 2:
    # Subject Details
    # --------------------------

    subject_rows = []

    # --------------------------
    # Process Each Student
    # --------------------------

    for idx, row in df.iterrows():

        student_id = row.get(
            'Student_ID',
            row.get('Student Number', idx + 1)
        )

        gwa = row.get('GWA', np.nan)

        grades = []

        inc_count = 0
        drp_count = 0
        fail_count = 0

        # ----------------------
        # Subject Loop
        # ----------------------

        for subject_code in subject_columns:

            raw_grade = row[subject_code]

            if pd.isna(raw_grade):
                continue

            grade_text = str(raw_grade).strip().upper()

            status = "Passed"

            if grade_text == "INC":
                status = "Incomplete"
                inc_count += 1

            elif grade_text == "DRP":
                status = "Dropped"
                drp_count += 1

            elif grade_text == "W":
                status = "Withdrawn"

            else:
                try:

                    numeric_grade = float(grade_text)

                    grades.append(numeric_grade)

                    # Adjust if your school uses another failing grade
                    if numeric_grade >= 5.0:
                        fail_count += 1
                        status = "Failed"

                except:
                    status = "Unknown"

            # Save detailed subject record

            subject_rows.append({

                "Student_ID": student_id,
                "Subject_Code": subject_code,
                "Grade": raw_grade,
                "Status": status

            })

        # ----------------------
        # Summary Features
        # ----------------------

        if len(grades) > 0:

            avg_grade = np.mean(grades)
            highest_grade = np.min(grades)
            lowest_grade = np.max(grades)

        else:

            avg_grade = np.nan
            highest_grade = np.nan
            lowest_grade = np.nan

        summary_rows.append({

            "Student_ID": student_id,

            "Gender": row.get("Gender"),

            "Program": row.get(
                "Program",
                row.get("Course")
            ),

            "Year_Level": row.get("Year_Level"),

            "Semester": row.get("Semester"),

            "School_Year": row.get("School_Year"),

            "GWA": gwa,

            "Avg_Subject_Grade": avg_grade,

            "Best_Grade": highest_grade,
            "Worst_Grade": lowest_grade,

            "INC_Count": inc_count,
            "DRP_Count": drp_count,
            "Failed_Count": fail_count,

            "Total_Subjects": len(subject_columns)

        })

    # --------------------------
    # Create DataFrames
    # --------------------------

    summary_df = pd.DataFrame(summary_rows)

    subjects_df = pd.DataFrame(subject_rows)

    # --------------------------
    # Save Files
    # --------------------------

    os.makedirs("processed", exist_ok=True)

    summary_df.to_csv(
        "processed/student_summary.csv",
        index=False
    )

    subjects_df.to_csv(
        "processed/student_subjects.csv",
        index=False
    )

    print("\nConversion Complete")

    print(summary_df.head())

    return summary_df, subjects_df


# ==========================
# RUN
# ==========================

if __name__ == "__main__":

    convert_excel(
        "uploads/student_file.xlsx"
    )