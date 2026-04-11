import pandas as pd
import numpy as np
import os
import joblib
from sklearn.linear_model import LinearRegression
from sklearn.metrics import r2_score, mean_squared_error

# --- CONFIGURATION ---
DATA_PATH = "processed_datasets/Final_Merged_Student_Data.csv"
MODEL_DIR = "Machine_Learning_Model"
os.makedirs(MODEL_DIR, exist_ok=True)

print("--- STARTING KPI MODEL TRAINING ---")

# LOAD DATA
if not os.path.exists(DATA_PATH):
    print(f"Error: Dataset not found at {DATA_PATH}")
    exit()

df = pd.read_csv(DATA_PATH)

# DATA PREPROCESSING
# Clean Year: "2022-2023" -> 2022
df['Year_Numeric'] = df['Year'].astype(str).str.extract(r'^(\d{4})').astype(int)

# Clean Semester: "1sem" -> 1, "2sem" -> 2
sem_map = {"1sem": 1, "1st Sem": 1, "2sem": 2, "2nd Sem": 2, "Summer": 3}
df['Sem_Numeric'] = df['Semester'].map(sem_map).fillna(1)

# Drop missing critical data
df = df.dropna(subset=['GWA', 'Year_Numeric', 'College'])

# MODEL A: GWA PERFORMANCE PREDICTOR
# Purpose: Predict Average GWA for 2025-2030
print("\nTraining GWA Performance Model...")

# Features: College (One-Hot), Year, Semester
X_gwa = pd.get_dummies(df[['College']], prefix='College')
X_gwa['Year_Numeric'] = df['Year_Numeric']
X_gwa['Sem_Numeric'] = df['Sem_Numeric']
y_gwa = df['GWA']

# Train
gwa_model = LinearRegression()
gwa_model.fit(X_gwa, y_gwa)

# Evaluate
y_gwa_pred = gwa_model.predict(X_gwa)
gwa_r2 = r2_score(y_gwa, y_gwa_pred)
gwa_mse = mean_squared_error(y_gwa, y_gwa_pred)

print(f"   > R² Score: {gwa_r2:.4f}")
print(f"   > MSE:      {gwa_mse:.4f}")

# Save
joblib.dump(gwa_model, os.path.join(MODEL_DIR, "kpi_gwa_model.pkl"))
joblib.dump(X_gwa.columns.tolist(), os.path.join(MODEL_DIR, "kpi_gwa_features.pkl"))


# MODEL B: ENROLLMENT FORECASTER
# Purpose: Predict Student Counts for 2025-2030
print("\nTraining Enrollment Forecast Model...")

# Group data to get counts per Year per College
# We count unique Student_IDs
enrollment_data = df.groupby(['Year_Numeric', 'College'])['Student_ID'].nunique().reset_index()
enrollment_data.rename(columns={'Student_ID': 'Student_Count'}, inplace=True)

# Features: College (One-Hot), Year
X_enroll = pd.get_dummies(enrollment_data[['College']], prefix='College')
X_enroll['Year_Numeric'] = enrollment_data['Year_Numeric']
y_enroll = enrollment_data['Student_Count']

# Train
enroll_model = LinearRegression()
enroll_model.fit(X_enroll, y_enroll)

# Evaluate
y_enroll_pred = enroll_model.predict(X_enroll)
enroll_r2 = r2_score(y_enroll, y_enroll_pred)

print(f"   > R² Score: {enroll_r2:.4f} (Accuracy on historical trends)")

# Save
joblib.dump(enroll_model, os.path.join(MODEL_DIR, "kpi_enrollment_model.pkl"))
joblib.dump(X_enroll.columns.tolist(), os.path.join(MODEL_DIR, "kpi_enrollment_features.pkl"))

print("\n--- TRAINING COMPLETE ---")
print(f"Models saved in: {MODEL_DIR}/")
