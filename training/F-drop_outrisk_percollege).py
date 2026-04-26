import pandas as pd
import numpy as np
import os
import joblib
from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import f1_score, accuracy_score

# --- CONFIGURATION ---
DATA_PATH = "processed_datasets/Final_Merged_Student_Data.csv"
MODEL_DIR = "Machine_Learning_Model"
os.makedirs(MODEL_DIR, exist_ok=True)

print("\n--- STUDENT STATUS PREDICTION (REGULAR vs INC vs DROP) ---")

# 1. LOAD DATA
if not os.path.exists(DATA_PATH):
    print(f"Error: Dataset not found at {DATA_PATH}")
    exit()

df = pd.read_csv(DATA_PATH)

# 2. MULTI-CLASS LABELING LOGIC (Ground Truth)
def classify_status(row):
    try:
        # Clean grade data
        g_val = str(row['Grade']).strip()
        g = float(g_val)
        status = str(row['Status']).upper()
        
        # DROP Logic (Value 2)
        if g in [0.0, 9.0] or any(x in status for x in ['DROP', 'WITHDRAW', 'LOA']):
            return 2
        # INC Logic (Value 1)
        if g in [5.0, 8.0] or 'INC' in status:
            return 1
    except:
        pass
    return 0 # REGULAR (Value 0)

print(" > Labeling Status Categories...")
df['status_signal'] = df.apply(classify_status, axis=1)

# 3. STUDENT LEVEL AGGREGATION
# We aggregate by Student_ID to have 1 row per student for the prediction
student_df = df.groupby("Student_ID").agg({
    "Gender": "first",
    "College": "first",
    "Semester": "first",
    "Year": "first",
    "Grade": ["mean", "min", "count"],
    "status_signal": "max" # Highest severity: if they have 1 drop in 5 subjects, they are 'Drop'
}).reset_index()

# Flatten MultiIndex Columns
student_df.columns = [
    "Student_ID", "Gender", "College", "Semester", "Year", 
    "Avg_Grade", "Min_Grade", "Subject_Count", "Status_Label"
]

# --- 4. FEATURE ENGINEERING ---
# Ensure Gender is numeric (0=Male, 1=Female already in CSV)
student_df["Gender_Code"] = pd.to_numeric(student_df["Gender"], errors="coerce").fillna(0).astype(int)

# Year extraction as before
student_df["Year_Numeric"] = student_df["Year"].astype(str).str.extract(r"(\d{4})")[0]
student_df["Year_Numeric"] = pd.to_numeric(student_df["Year_Numeric"], errors="coerce").fillna(2024)


# 5. PREPARE FEATURES (X) AND TARGET (y)
# Using get_dummies for categorical variables (College and Semester)
X = pd.get_dummies(
    student_df[[
        "Gender_Code", "College", "Semester", "Year_Numeric", 
        "Avg_Grade", "Min_Grade", "Subject_Count"
    ]],
    columns=["College", "Semester"],
    drop_first=False
)
y = student_df["Status_Label"]

# Save the exact column order for the API to use later
joblib.dump(X.columns.tolist(), os.path.join(MODEL_DIR, "dropout_features.pkl"))

# 6. TRAIN / TEST SPLIT
# Stratify=y ensures the ratio of Regular/INC/Drop is the same in both sets
X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, random_state=42, stratify=y
)

# 7. MODEL TRAINING (Random Forest)
print(f" > Training Model on {len(X_train)} students...")
model = RandomForestClassifier(
    n_estimators=300,        # Increased for better INC detection
    max_depth=12,            # Balanced depth to prevent overfitting
    class_weight='balanced', # Crucial: gives more weight to the rare INC and Drop cases
    random_state=42
)
model.fit(X_train, y_train)

# 8. EVALUATION
y_pred = model.predict(X_test)
acc = accuracy_score(y_test, y_pred)
# We use 'macro' to give equal weight to Regular, INC, and Drop performance
f1_macro = f1_score(y_test, y_pred, average='macro') 

print("\n--- MODEL EVALUATION ---")
print(f" F1 Score (Macro)       = {f1_macro:.4f}")
print(f" Prediction Accuracy    = {acc:.4f}")

# 9. SAVE MODEL
joblib.dump(model, os.path.join(MODEL_DIR, "dropout_model.pkl"))
print(f"\n[SUCCESS] Model saved to {MODEL_DIR}/dropout_model.pkl")
print(f"[SUCCESS] Features saved to {MODEL_DIR}/dropout_features.pkl")