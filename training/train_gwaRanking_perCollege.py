import pandas as pd
import numpy as np
import os
import joblib
from sklearn.model_selection import train_test_split
from sklearn.linear_model import LinearRegression
from sklearn.metrics import r2_score, mean_squared_error

# 1. SETUP
DATA_PATH = "processed_datasets/Final_Merged_Student_Data.csv"
MODEL_DIR = "Machine_Learning_Model"
os.makedirs(MODEL_DIR, exist_ok=True)

print("--- TRAINING GWA RANKING MODEL (1.0 - 5.0 Scale) ---")

if not os.path.exists(DATA_PATH):
    print(f"Error: Dataset not found at {DATA_PATH}")
    exit()

df = pd.read_csv(DATA_PATH)

# 2. DATA CLEANING
# Clean Year
df['Year_Numeric'] = df['Year'].astype(str).str.extract(r'(\d{4})')[0].astype(float)

# Clean Semester
# Map: '1st Sem'->1, '2nd Sem'->2, 'Summer'->3
sem_map = {'1': 1, '2': 2, 'SUMMER': 3}
df['Sem_Numeric'] = df['Semester'].astype(str).str.upper().apply(
    lambda x: next((v for k, v in sem_map.items() if k in x), 1)
)

# CRITICAL: Filter GWA to Valid Range (1.0 - 5.0)
# Remove 0s, 60s, 90s, etc.
df['GWA'] = pd.to_numeric(df['GWA'], errors='coerce')
df = df.dropna(subset=['GWA', 'College', 'Year_Numeric'])
df = df[(df['GWA'] >= 1.0) & (df['GWA'] <= 5.0)]

print(f" > Valid Data Points: {len(df)}")

# 3. FEATURE ENGINEERING
# One-hot encode College (College_CBA, College_CCST, etc.)
# drop_first=False ensures every college has its own explicit weight
X_cats = pd.get_dummies(df[['College']], prefix='College')

# Add Numeric Features
X = pd.concat([X_cats], axis=1)
X['Year_Numeric'] = df['Year_Numeric']
X['Sem_Numeric'] = df['Sem_Numeric']

y = df['GWA']

# Save features to ensure the API creates the exact same input columns
joblib.dump(X.columns.tolist(), os.path.join(MODEL_DIR, "gwa_ranking_features_final.pkl"))

# 4. TRAINING
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

model = LinearRegression()
model.fit(X_train, y_train)

# 5. EVALUATION
y_pred = model.predict(X_test)
mse = mean_squared_error(y_test, y_pred)
r2 = r2_score(y_test, y_pred)

print(f" > MSE: {mse:.4f} (Lower is better)")
print(f" > R²:  {r2:.4f}")

# 6. SAVE
joblib.dump(model, os.path.join(MODEL_DIR, "gwa_ranking_model_final.pkl"))
print(f"\nSaved model to {MODEL_DIR}/gwa_ranking_model_final.pkl")