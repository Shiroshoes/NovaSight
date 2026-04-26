import pandas as pd
import numpy as np
import joblib
import os
from sklearn.linear_model import LinearRegression
from sklearn.metrics import r2_score, root_mean_squared_error

# CONFIGURATION
DATA_PATH = "processed_datasets/Final_Merged_Student_Data.csv"
MODEL_DIR = "Machine_Learning_Model"
os.makedirs(MODEL_DIR, exist_ok=True)

print(" TRAINING DROPOUT SPIKE MODEL (Aggregated Rates) ")

if not os.path.exists(DATA_PATH):
    print(f"Error: Dataset not found at {DATA_PATH}")
    exit()

df = pd.read_csv(DATA_PATH)

# 1. DATA CLEANING
# Fix Year: "2022-2023" -> 2022
df['Year_Numeric'] = df['Year'].astype(str).str.extract(r'^(\d{4})').astype(int)

# Fix Status — CSV values are: REGULAR, DROP, INC
if 'Status' in df.columns:
    df['Status'] = df['Status'].astype(str).str.strip().str.upper()
else:
    print("Error: 'Status' column missing.")
    exit()

# 2. STUDENT-LEVEL AGGREGATION
# A student is a dropout if any of their subject rows has Status == DROP
print(" > Aggregating by Student...")
student_df = df.groupby(['Student_ID', 'Year_Numeric', 'College'])['Status'].apply(list).reset_index()

student_df['is_dropout'] = student_df['Status'].apply(
    lambda statuses: 1 if any("DROP" in str(s) for s in statuses) else 0
)

# 3. COHORT AGGREGATION (Dropout Rate % per Year x College)
cohort_stats = student_df.groupby(['Year_Numeric', 'College']).agg(
    total_students=('Student_ID', 'count'),
    dropout_count=('is_dropout', 'sum')
).reset_index()

cohort_stats['Dropout_Rate'] = (cohort_stats['dropout_count'] / cohort_stats['total_students']) * 100
cohort_stats = cohort_stats[cohort_stats['total_students'] > 5]

print(f" > Training Data Points: {len(cohort_stats)} (Years x Colleges)")

# 4. FEATURE ENGINEERING
X = pd.get_dummies(cohort_stats[['College']], prefix='College')
X['Year_Numeric'] = cohort_stats['Year_Numeric'].values
y = cohort_stats['Dropout_Rate'].values

# Save Feature List (API must match these columns)
joblib.dump(X.columns.tolist(), os.path.join(MODEL_DIR, "dropout_spike_features.pkl"))

# 5. TRAINING
model = LinearRegression()
model.fit(X, y)

# 6. EVALUATION — Linear Regression: RMSE + R²
y_pred = model.predict(X)
rmse = np.sqrt(root_mean_squared_error(y, y_pred))
r2   = r2_score(y, y_pred)

print("\n--- MODEL EVALUATION ---")
print(f" RMSE    = {rmse:.4f}")
print(f" R²      = {r2:.4f}")

# 7. SAVE
joblib.dump(model, os.path.join(MODEL_DIR, "dropout_spike_model.pkl"))
print(f"\n[SUCCESS] Model saved to {MODEL_DIR}/dropout_spike_model.pkl")