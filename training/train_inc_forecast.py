import pandas as pd
import numpy as np
import joblib
import os
from sklearn.linear_model import LinearRegression
from sklearn.metrics import r2_score, mean_squared_error

# --- CONFIGURATION ---
DATA_PATH = "processed_datasets/Final_Merged_Student_Data.csv"
MODEL_DIR = "Machine_Learning_Model"
os.makedirs(MODEL_DIR, exist_ok=True)

print("--- TRAINING INC RATE FORECAST MODEL (Status-Based) ---")

# 1. LOAD DATA
if not os.path.exists(DATA_PATH):
    print(f"Error: Dataset not found at {DATA_PATH}")
    exit()

df = pd.read_csv(DATA_PATH)

# 2. PREPROCESSING
# Clean Year
df['Year_Numeric'] = df['Year'].astype(str).str.extract(r'^(\d{4})').astype(int)

# Clean Status
if 'Status' not in df.columns:
    print("Error: 'Status' column missing. Cannot train.")
    exit()

# Standardize Status
df['Status'] = df['Status'].astype(str).str.strip().str.upper()

# 3. IDENTIFY INC STUDENTS (Student-Level Aggregation)
# We group by Student+Year+College to see if they had ANY 'INC' subject that year.
print(" > Aggregating by Student...")

# Helper: Check if 'INC' is in the list of statuses for a student
student_df = df.groupby(['Student_ID', 'Year_Numeric', 'College'])['Status'].apply(
    lambda statuses: 1 if any("INC" in s for s in statuses) else 0
).reset_index(name='has_inc')

# 4. CALCULATE RATE (College-Level Aggregation)
# Now we count how many students had INC vs Total Students
cohort_stats = student_df.groupby(['Year_Numeric', 'College']).agg(
    total_students=('Student_ID', 'count'),
    inc_student_count=('has_inc', 'sum')
).reset_index()

# Calculate Percentage
cohort_stats['INC_Rate'] = (cohort_stats['inc_student_count'] / cohort_stats['total_students']) * 100

# Filter out noise (years with very few students)
cohort_stats = cohort_stats[cohort_stats['total_students'] > 5]

print(f" > Training Data Points: {len(cohort_stats)}")

# 5. TRAIN MODEL
# Features: College (One-Hot), Year
X = pd.get_dummies(cohort_stats[['College']], prefix='College')
X['Year_Numeric'] = cohort_stats['Year_Numeric']
y = cohort_stats['INC_Rate']

model = LinearRegression()
model.fit(X, y)

# 6. EVALUATE
y_pred = model.predict(X)
r2 = r2_score(y, y_pred)
mse = mean_squared_error(y, y_pred)

print(f"\nModel Performance:")
print(f" > R² Score: {r2:.4f}")
print(f" > MSE:      {mse:.4f}")

# 7. SAVE
joblib.dump(model, os.path.join(MODEL_DIR, "inc_rate_model.pkl"))
joblib.dump(X.columns.tolist(), os.path.join(MODEL_DIR, "inc_rate_features.pkl"))

print(f"\nSaved to {MODEL_DIR}/")