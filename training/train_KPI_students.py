import pandas as pd
import numpy as np
import os
import joblib
from sklearn.linear_model import LinearRegression
from sklearn.metrics import r2_score, root_mean_squared_error

# CONFIGURATION
DATA_PATH = "processed_datasets/Final_Merged_Student_Data.csv"
MODEL_DIR = "Machine_Learning_Model"
os.makedirs(MODEL_DIR, exist_ok=True)

print("--- TRAINING KPI MODELS (GWA + Enrollment) ---")

if not os.path.exists(DATA_PATH):
    print(f"Error: Dataset not found at {DATA_PATH}")
    exit()

df = pd.read_csv(DATA_PATH)

# 1. CLEANING
df['Year_Numeric'] = df['Year'].astype(str).str.extract(r'^(\d{4})').astype(float)

# FIX: Semester map aligned to actual CSV values ("1sem", "2sem")
sem_map = {"1sem": 1, "1st": 1, "2sem": 2, "2nd": 2, "summer": 3}
df['Sem_Numeric'] = df['Semester'].astype(str).str.lower().apply(
    lambda x: next((v for k, v in sem_map.items() if k in x), 1)
)

# Filter GWA to valid range (1.0 - 5.0)
df['GWA'] = pd.to_numeric(df['GWA'], errors='coerce')
df = df.dropna(subset=['GWA', 'Year_Numeric', 'College'])
df = df[(df['GWA'] >= 1.0) & (df['GWA'] <= 5.0)]

print(f" > Data Loaded: {len(df)} valid rows (GWA 1.0–5.0)")

# --- MODEL A: GWA FORECASTER ---
print("\nTraining GWA Forecast Model...")

X_gwa = pd.get_dummies(df[['College']], prefix='College')
X_gwa['Year_Numeric'] = df['Year_Numeric'].values
X_gwa['Sem_Numeric']  = df['Sem_Numeric'].values
y_gwa = df['GWA'].values

gwa_model = LinearRegression()
gwa_model.fit(X_gwa, y_gwa)

y_gwa_pred = gwa_model.predict(X_gwa)
rmse_gwa = np.sqrt(root_mean_squared_error(y_gwa, y_gwa_pred))
r2_gwa   = r2_score(y_gwa, y_gwa_pred)

print("\n--- GWA MODEL EVALUATION ---")
print(f" RMSE    = {rmse_gwa:.4f}")
print(f" R²      = {r2_gwa:.4f}")

joblib.dump(gwa_model, os.path.join(MODEL_DIR, "kpi_gwa_model.pkl"))
joblib.dump(X_gwa.columns.tolist(), os.path.join(MODEL_DIR, "kpi_gwa_features.pkl"))

# --- MODEL B: ENROLLMENT FORECASTER ---
print("\nTraining Enrollment Forecast Model...")

enroll_df = df.groupby(['Year_Numeric', 'College'])['Student_ID'].nunique().reset_index()
enroll_df.rename(columns={'Student_ID': 'Count'}, inplace=True)

X_enroll = pd.get_dummies(enroll_df[['College']], prefix='College')
X_enroll['Year_Numeric'] = enroll_df['Year_Numeric'].values
y_enroll = enroll_df['Count'].values

enroll_model = LinearRegression()
enroll_model.fit(X_enroll, y_enroll)

y_enroll_pred = enroll_model.predict(X_enroll)
rmse_enroll = np.sqrt(root_mean_squared_error(y_enroll, y_enroll_pred))
r2_enroll   = r2_score(y_enroll, y_enroll_pred)

print("\n--- ENROLLMENT MODEL EVALUATION ---")
print(f" RMSE    = {rmse_enroll:.4f}")
print(f" R²      = {r2_enroll:.4f}")

joblib.dump(enroll_model, os.path.join(MODEL_DIR, "kpi_enrollment_model.pkl"))
joblib.dump(X_enroll.columns.tolist(), os.path.join(MODEL_DIR, "kpi_enrollment_features.pkl"))

print(f"\n[SUCCESS] Models saved to {MODEL_DIR}/")