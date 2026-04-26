import pandas as pd
import numpy as np
import os
import joblib
from sklearn.model_selection import train_test_split
from sklearn.linear_model import LinearRegression
from sklearn.metrics import r2_score, root_mean_squared_error

# CONFIG
DATA_PATH = "processed_datasets/Final_Merged_Student_Data.csv"
MODEL_DIR = "Machine_Learning_Model"
os.makedirs(MODEL_DIR, exist_ok=True)

print("\n--- TRAINING DROPOUT RANKING MODEL (Grade-Based) ---")
# CSV NOTES:
# - No DROP in Status. Dropout = any Grade == 0 for a student.
# - Status values: "REGULAR", "INC"

if not os.path.exists(DATA_PATH):
    print(f"Error: {DATA_PATH} not found."); exit()

df = pd.read_csv(DATA_PATH)

# DATA CLEANING
df["College"]      = df["College"].astype(str).str.strip().str.upper()
df["Semester"]     = df["Semester"].astype(str).str.strip().str.upper()
df["Status"]       = df["Status"].astype(str).str.strip().str.upper()
df["Year_Numeric"] = df["Year"].astype(str).str.extract(r"(\d{4})")[0].astype(float)

# STUDENT-LEVEL AGGREGATION
# FIX: Use Status == 'DROP' (not grade == 0) — CSV already has a proper Status column
student_df = df.groupby("Student_ID").agg({
    "College":      "first",
    "Year_Numeric": "first",
    "Semester":     "first",
    "Status":       list
}).reset_index()

student_df["is_drop"] = student_df["Status"].apply(
    lambda statuses: int(any("DROP" in str(s) for s in statuses))
)

print(f" > Total Students:  {len(student_df)}")
print(f" > Total Dropouts:  {student_df['is_drop'].sum()}")

# FEATURES
X = pd.get_dummies(student_df[["College", "Semester"]], drop_first=False)
X["Year_Numeric"] = student_df["Year_Numeric"].values
y = student_df["is_drop"].values

joblib.dump(X.columns.tolist(), os.path.join(MODEL_DIR, "dropout_ranking_features_final.pkl"))

X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

model = LinearRegression()
model.fit(X_train, y_train)

# EVALUATION — Linear Regression: RMSE + R²
y_pred = model.predict(X_test)
rmse = np.sqrt(root_mean_squared_error(y_test, y_pred))
r2   = r2_score(y_test, y_pred)

print("\n--- MODEL EVALUATION ---")
print(f" RMSE    = {rmse:.4f}")
print(f" R²      = {r2:.4f}")

joblib.dump(model, os.path.join(MODEL_DIR, "college_dropout_model_final.pkl"))
print(f"\n[SUCCESS] Saved to {MODEL_DIR}/college_dropout_model_final.pkl")