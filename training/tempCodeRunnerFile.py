import pandas as pd
import numpy as np
import os
import joblib

from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_squared_error, r2_score, accuracy_score

#  CONFIG

DATA_PATH = "processed_datasets/Final_Merged_Student_Data.csv"
MODEL_DIR = "Machine_Learning_Model"
os.makedirs(MODEL_DIR, exist_ok=True)

print("\n--- STUDENT-LEVEL DROPOUT MODEL ---")

#  LOAD DATA

if not os.path.exists(DATA_PATH):
    print("Error: Dataset not found.")
    exit()

df = pd.read_csv(DATA_PATH)

#
# 1. CREATE STUDENT-LEVEL AGGREGATION
#

student_df = df.groupby("Student_ID").agg({

    "Gender": "first",
    "College": "first",
    "Semester": "first",
    "Year": "first",

    # performance signals
    "Grade": ["mean", "count"],   # avg grade + number of subjects
    "GWA": "first"
})

# flatten columns
student_df.columns = [
    "Gender",
    "College",
    "Semester",
    "Year",
    "Avg_Grade",
    "Subject_Count",
    "GWA"
]

student_df = student_df.reset_index()

#  TARGET (student-level)

# student is drop if ANY subject = 0
drop_map = df.groupby("Student_ID")["Grade"].apply(lambda x: (x == 0).any())

student_df["is_drop"] = student_df["Student_ID"].map(drop_map).astype(int)

#  FEATURE ENGINEERING 

student_df["is_inc_student"] = df.groupby("Student_ID")["Grade"].apply(lambda x: (x == 5).any()).values
student_df["fail_rate"] = df.groupby("Student_ID")["Grade"].apply(lambda x: (x >= 3).mean()).values

# Year numeric
student_df["Year_Numeric"] = student_df["Year"].astype(str).str.extract(r"(\d{4})")[0]
student_df["Year_Numeric"] = pd.to_numeric(student_df["Year_Numeric"], errors="coerce").fillna(0)

# Gender encoding
if student_df["Gender"].dtype == "object":
    student_df["Gender"] = student_df["Gender"].map({"Male": 0, "Female": 1}).fillna(0)

#  FEATURES

X = pd.get_dummies(
    student_df[[
        "Gender",
        "College",
        "Semester",
        "Year_Numeric",
        "GWA",
        "Avg_Grade",
        "Subject_Count",
        "is_inc_student",
        "fail_rate"
    ]],
    drop_first=False
)

y = student_df["is_drop"]

#  TRAIN / TEST

X_train, X_test, y_train, y_test = train_test_split(
    X, y,
    test_size=0.2,
    random_state=42,
    stratify=y
)

#  MODEL 

print("\n > Training Random Forest Regressor (Student-Level)...")

model = RandomForestRegressor(
    n_estimators=200,
    random_state=42
)

model.fit(X_train, y_train)

#  PREDICTIONS 

y_pred_raw = model.predict(X_test)
y_pred_raw = np.clip(y_pred_raw, 0, 1)

y_pred_class = (y_pred_raw >= 0.5).astype(int)

#  METRICS 

mse = mean_squared_error(y_test, y_pred_raw)
r2 = r2_score(y_test, y_pred_raw)
acc = accuracy_score(y_test, y_pred_class)

print("\n--- Model Evaluation ---")
print(f" > MSE:      {mse:.4f}")
print(f" > R² Score: {r2:.4f}")
print(f" > Accuracy: {acc:.2%}")

#  FEATURE IMPORTANCE

importance = pd.DataFrame({
    "feature": X.columns,
    "importance": model.feature_importances_
}).sort_values(by="importance", ascending=False)

print("\nTop Features:")
print(importance.head(10))

#  SAVE MODEL

joblib.dump(model, os.path.join(MODEL_DIR, "dropout_model.pkl"))
joblib.dump(X.columns.tolist(), os.path.join(MODEL_DIR, "dropout_features.pkl"))

print(f"\nSaved model to {MODEL_DIR}/")