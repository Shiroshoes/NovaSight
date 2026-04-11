import pandas as pd
import numpy as np
import joblib
import os
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import r2_score, mean_squared_error

# --- CONFIGURATION ---
DATA_PATH = "processed_datasets/Final_Merged_Student_Data.csv"
MODEL_DIR = "Machine_Learning_Model"
os.makedirs(MODEL_DIR, exist_ok=True)

print("--- TRAINING SUBJECT FORECAST MODEL ---")

# 1. LOAD DATA
if not os.path.exists(DATA_PATH):
    print("Error: Dataset not found.")
    exit()

df = pd.read_csv(DATA_PATH)

# 2. PREPROCESSING
df['Year_Numeric'] = df['Year'].astype(str).str.extract(r'^(\d{4})').astype(int)

# --- FIX: USE CORRECT COLUMN NAME ---
# We explicitly map your column 'Course_Subject_Name' to a standard 'Subject' variable
if 'Course_Subject_Name' in df.columns:
    df['Subject'] = df['Course_Subject_Name']
elif 'Subject' not in df.columns:
    print("CRITICAL ERROR: Neither 'Course_Subject_Name' nor 'Subject' column found.")
    exit()

# 3. FILTER TO TOP 50 SUBJECTS
# This keeps the model focused on major subjects
top_subjects = df['Subject'].value_counts().nlargest(50).index.tolist()
df = df[df['Subject'].isin(top_subjects)]

print(f" > Training on top {len(top_subjects)} subjects (e.g., {top_subjects[:3]})...")

# 4. TRAIN MODEL
target_col = 'Grade' if 'Grade' in df.columns else 'GWA'
# We use One-Hot Encoding for College and Subject
X = pd.get_dummies(df[['Year_Numeric', 'College', 'Subject']], columns=['College', 'Subject'])
y = df[target_col]

model = RandomForestRegressor(n_estimators=50, random_state=42)
model.fit(X, y)

# 5. EVALUATE & SAVE
y_pred = model.predict(X)
print(f" > R² Score: {r2_score(y, y_pred):.4f}")

joblib.dump(model, os.path.join(MODEL_DIR, "subject_grade_model.pkl"))
joblib.dump(X.columns.tolist(), os.path.join(MODEL_DIR, "subject_grade_features.pkl"))

print(f"Model saved successfully.")
