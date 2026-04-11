import pandas as pd
import numpy as np
import joblib
import os
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import r2_score, mean_absolute_error

#  CONFIGURATION 
DATA_PATH = "processed_datasets/Final_Merged_Student_Data.csv"
MODEL_DIR = "Machine_Learning_Model"
os.makedirs(MODEL_DIR, exist_ok=True)

print(" TRAINING RANDOM FOREST FOR STATUS DISTRIBUTION ")

# LOAD DATA
if not os.path.exists(DATA_PATH):
    print("Error: Dataset not found.")
    exit()

df = pd.read_csv(DATA_PATH)

# PREPROCESSING
# Clean Year (e.g., "2022-2023" -> 2022)
df['Year_Numeric'] = df['Year'].astype(str).str.extract(r'^(\d{4})').astype(int)

# Clean Semester (1sem -> 1, 2sem -> 2)
sem_map = {"1sem": 1, "1st Sem": 1, "2sem": 2, "2nd Sem": 2, "Summer": 3}
df['Sem_Numeric'] = df['Semester'].map(sem_map).fillna(1)

# Clean Target
df = df.dropna(subset=['GWA', 'College'])

# FEATURE ENGINEERING
# We use One-Hot Encoding for Colleges to let the tree learn specific department trends
X = pd.get_dummies(df[['College']], prefix='College')
X['Year_Numeric'] = df['Year_Numeric']
X['Sem_Numeric'] = df['Sem_Numeric']
y = df['GWA']

# TRAIN RANDOM FOREST
# n_estimators=100 means we build 100 decision trees
print("Training Model (this may take a moment)...")
model = RandomForestRegressor(n_estimators=100, random_state=42)
model.fit(X, y)

# EVALUATE
y_pred = model.predict(X)
r2 = r2_score(y, y_pred)
mae = mean_absolute_error(y, y_pred)

print(f"\nModel Performance:")
print(f" > R² Score: {r2:.4f} (Target: > 0.85)")
print(f" > Avg Error: {mae:.4f} GWA points")

# 6. SAVE ARTIFACTS
joblib.dump(model, os.path.join(MODEL_DIR, "status_forest_model.pkl"))
joblib.dump(X.columns.tolist(), os.path.join(MODEL_DIR, "status_forest_features.pkl"))

print(f"\nSaved to {MODEL_DIR}/status_forest_model.pkl")
