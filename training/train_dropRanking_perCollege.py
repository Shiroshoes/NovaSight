import pandas as pd
import numpy as np
import os
import joblib
from sklearn.model_selection import train_test_split
from sklearn.linear_model import LinearRegression
from sklearn.metrics import r2_score, mean_squared_error

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
df["Year_Numeric"] = df["Year"].astype(str).str.extract(r"(\d{4})")[0].astype(float)

# STUDENT-LEVEL AGGREGATION
student_df = df.groupby("Student_ID").agg({
    "College":      "first",
    "Year_Numeric": "first",
    "Semester":     "first",
    "Grade":        list
}).reset_index()

# TARGET: dropped if any Grade == 0
student_df["is_drop"] = student_df["Grade"].apply(
    lambda grades: int(any(g == 0 for g in grades))
)

print(f" > Total Students:  {len(student_df)}")
print(f" > Total Dropouts:  {student_df['is_drop'].sum()}")

# FEATURES
X = pd.get_dummies(student_df[["College", "Semester"]], drop_first=False)
X["Year_Numeric"] = student_df["Year_Numeric"]
y = student_df["is_drop"]

joblib.dump(X.columns.tolist(), os.path.join(MODEL_DIR, "dropout_ranking_features_final.pkl"))

X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

model = LinearRegression()
model.fit(X_train, y_train)

y_pred = model.predict(X_test)
print(f" > R2 Score: {r2_score(y_test, y_pred):.4f}")
print(f" > MSE:      {mean_squared_error(y_test, y_pred):.4f}")

joblib.dump(model, os.path.join(MODEL_DIR, "college_dropout_model_final.pkl"))
print(f"\nSaved to {MODEL_DIR}/college_dropout_model_final.pkl")