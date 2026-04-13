import pandas as pd
import numpy as np
import joblib
import os
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import r2_score

# --- CONFIGURATION ---
DATA_PATH = "processed_datasets/Final_Merged_Student_Data.csv"
MODEL_DIR = "Machine_Learning_Model"
os.makedirs(MODEL_DIR, exist_ok=True)

print("--- TRAINING SUBJECT GRADE FORECAST MODEL ---")

if not os.path.exists(DATA_PATH):
    print(f"Error: Dataset not found at {DATA_PATH}")
    exit()

df = pd.read_csv(DATA_PATH)

# 1. PREPROCESSING
df['Year_Numeric'] = df['Year'].astype(str).str.extract(r'^(\d{4})').astype(float)

# Map Subject Name
if 'Course_Subject_Name' in df.columns:
    df['Subject'] = df['Course_Subject_Name'].str.upper().str.strip()
elif 'Subject' in df.columns:
    df['Subject'] = df['Subject'].str.upper().str.strip()
else:
    print("Error: Subject column not found.")
    exit()

# Clean Grades (Remove INC, DROP, Convert to Float)
df['Grade'] = pd.to_numeric(df['Grade'], errors='coerce')
df = df.dropna(subset=['Grade', 'Year_Numeric', 'College', 'Subject'])
df = df[(df['Grade'] >= 1.0) & (df['Grade'] <= 5.0)] # Valid range

# 2. FILTER TO MAJOR SUBJECTS
# Keep top 50 subjects by volume to ensure statistical significance
top_subjects = df['Subject'].value_counts().nlargest(60).index.tolist()
df = df[df['Subject'].isin(top_subjects)]

print(f" > Aggregating trends for {len(top_subjects)} major subjects...")

# 3. AGGREGATE TRENDS (Target: Average Grade per Year/College/Subject)
# This creates a stable trend line rather than noisy individual points
trend_df = df.groupby(['Year_Numeric', 'College', 'Subject'])['Grade'].mean().reset_index()

# 4. FEATURE ENGINEERING
# One-Hot Encode Categorical Data
X = pd.get_dummies(trend_df[['College', 'Subject']], prefix=['College', 'Subject'])
X['Year_Numeric'] = trend_df['Year_Numeric']
y = trend_df['Grade']

# Save Columns (Critical for API)
joblib.dump(X.columns.tolist(), os.path.join(MODEL_DIR, "subject_grade_features.pkl"))

# 5. TRAINING
model = RandomForestRegressor(n_estimators=100, random_state=42)
model.fit(X, y)

# 6. EVALUATE
y_pred = model.predict(X)
r2 = r2_score(y, y_pred)
print(f" > Model R² Score: {r2:.4f}")

# 7. SAVE
joblib.dump(model, os.path.join(MODEL_DIR, "subject_grade_model.pkl"))
print(f"\nModel saved to {MODEL_DIR}/subject_grade_model.pkl")