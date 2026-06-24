import pandas as pd
import numpy as np
import os
import joblib
from sklearn.linear_model import LinearRegression
from sklearn.metrics import r2_score, mean_squared_error

# CONFIGURATION
DATA_PATH = "processed_datasets/Final_Merged_Student_Data.csv"
MODEL_DIR = "Machine_Learning_Model"
os.makedirs(MODEL_DIR, exist_ok=True)

print("--- STARTING KPI MODEL TRAINING (GWA 1.0 - 5.0) ---")

if not os.path.exists(DATA_PATH):
    print(f"Error: Dataset not found at {DATA_PATH}")
    exit()

df = pd.read_csv(DATA_PATH)

# 1. CLEANING
# Year
df['Year_Numeric'] = df['Year'].astype(str).str.extract(r'^(\d{4})').astype(float)

# Semester Map
sem_map = {"1sem": 1, "1st": 1, "2sem": 2, "2nd": 2, "summer": 3}
df['Sem_Numeric'] = df['Semester'].astype(str).str.lower().apply(
    lambda x: next((v for k, v in sem_map.items() if k in x), 1)
)

# CRITICAL: Filter GWA to 1.0 - 5.0 Range
df['GWA'] = pd.to_numeric(df['GWA'], errors='coerce')
df = df.dropna(subset=['GWA', 'Year_Numeric', 'College'])
df = df[(df['GWA'] >= 1.0) & (df['GWA'] <= 5.0)]

print(f" > Data Loaded: {len(df)} valid rows (GWA 1.0-5.0)")

# MODEL A: GWA PREDICTOR (Linear Regression)
print("\nTraining GWA Forecast Model...")

# Features: College (One-Hot), Year, Semester
X_gwa = pd.get_dummies(df[['College']], prefix='College')
X_gwa['Year_Numeric'] = df['Year_Numeric']
X_gwa['Sem_Numeric'] = df['Sem_Numeric']
y_gwa = df['GWA']

gwa_model = LinearRegression()
gwa_model.fit(X_gwa, y_gwa)

# Metric
y_gwa_pred = gwa_model.predict(X_gwa)
print(f"   > MSE: {mean_squared_error(y_gwa, y_gwa_pred):.4f} (Lower is better)")

# Save
joblib.dump(gwa_model, os.path.join(MODEL_DIR, "kpi_gwa_model.pkl"))
joblib.dump(X_gwa.columns.tolist(), os.path.join(MODEL_DIR, "kpi_gwa_features.pkl"))


# MODEL B: ENROLLMENT FORECASTER
print("\nTraining Enrollment Forecast Model...")

# Aggregate: Count unique Student IDs per College per Year
enroll_df = df.groupby(['Year_Numeric', 'College'])['Student_ID'].nunique().reset_index()
enroll_df.rename(columns={'Student_ID': 'Count'}, inplace=True)

# Features
X_enroll = pd.get_dummies(enroll_df[['College']], prefix='College')
X_enroll['Year_Numeric'] = enroll_df['Year_Numeric']
y_enroll = enroll_df['Count']

enroll_model = LinearRegression()
enroll_model.fit(X_enroll, y_enroll)

# Metric
y_enroll_pred = enroll_model.predict(X_enroll)
print(f"   > R² Score: {r2_score(y_enroll, y_enroll_pred):.4f}")

# Save
joblib.dump(enroll_model, os.path.join(MODEL_DIR, "kpi_enrollment_model.pkl"))
joblib.dump(X_enroll.columns.tolist(), os.path.join(MODEL_DIR, "kpi_enrollment_features.pkl"))

print("\ TRAINING COMPLETE")
print(f"Models saved to {MODEL_DIR}/")