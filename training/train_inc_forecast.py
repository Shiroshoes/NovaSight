import pandas as pd
import numpy as np
import joblib
import os
from sklearn.ensemble import RandomForestRegressor # Non-linear is better for forecasting
from sklearn.metrics import r2_score, root_mean_squared_error

# CONFIGURATION
DATA_PATH = "processed_datasets/Final_Merged_Student_Data.csv"
MODEL_DIR = "Machine_Learning_Model"
os.makedirs(MODEL_DIR, exist_ok=True)

print("--- TRAINING SMART INC RATE FORECAST MODEL ---")

# 1. LOAD DATA
df = pd.read_csv(DATA_PATH)

# 2. PREPROCESSING
df['Year_Numeric'] = df['Year'].astype(str).str.extract(r'^(\d{4})').astype(int)
df['Status'] = df['Status'].astype(str).str.strip().str.upper()

# 3. STUDENT-LEVEL AGGREGATION (Adding GWA as a predictor)
print(" > Aggregating by Student...")
student_df = df.groupby(['Student_ID', 'Year_Numeric', 'College']).agg({
    'Status': lambda s: 1 if any("INC" in str(x).upper() for x in s) else 0,
    'GWA': 'mean' # Include performance context
}).reset_index()
student_df.rename(columns={'Status': 'has_inc'}, inplace=True)

# 4. COHORT AGGREGATION
cohort_stats = student_df.groupby(['Year_Numeric', 'College']).agg(
    total_students=('Student_ID', 'count'),
    inc_student_count=('has_inc', 'sum'),
    avg_gwa=('GWA', 'mean') # The model now "knows" if the cohort is doing better
).reset_index()

cohort_stats['INC_Rate'] = (cohort_stats['inc_student_count'] / cohort_stats['total_students']) * 100
cohort_stats = cohort_stats[cohort_stats['total_students'] > 5]

# 5. FEATURES + TARGET
X_cats = pd.get_dummies(cohort_stats[['College']], prefix='College')
X = pd.concat([X_cats, cohort_stats[['Year_Numeric', 'avg_gwa']]], axis=1)
y = cohort_stats['INC_Rate'].values

# 6. TRAIN (Random Forest Regressor)
# This model can predict a decrease if it sees GWA improving
model = RandomForestRegressor(n_estimators=100, random_state=42)
model.fit(X, y)

# 7. EVALUATION (RMSE + R²)
y_pred = model.predict(X)
rmse = root_mean_squared_error(y, y_pred) # No need for sqrt if using this specific function
r2 = r2_score(y, y_pred)

print("\n--- MODEL EVALUATION (Regression) ---")
print(f" RMSE    = {rmse:.4f} (Avg % error)")
print(f" R²      = {r2:.4f} (Fit quality)")

# Note: For your classification model (Dropout), use:
# Accuracy: Percentage of correct status guesses.
# F1 Score: Reliability in catching at-risk students.

# 8. SAVE
joblib.dump(model, os.path.join(MODEL_DIR, "inc_rate_model.pkl"))
joblib.dump(X.columns.tolist(), os.path.join(MODEL_DIR, "inc_rate_features.pkl"))
print(f"\n[SUCCESS] Saved to {MODEL_DIR}/")
