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

print("--- TRAINING INC RATE FORECAST MODEL ---")

# LOAD DATA
if not os.path.exists(DATA_PATH):
    print("Error: Dataset not found.")
    exit()

df = pd.read_csv(DATA_PATH)

# PREPROCESSING
# Clean Year
df['Year_Numeric'] = df['Year'].astype(str).str.extract(r'^(\d{4})').astype(int)

# --- CRITICAL: IDENTIFY INC STUDENTS ---
# Adjust 'Remarks' and 'INC' to match your actual CSV column/value
# Example: df['is_inc'] = df['Grade'] == 'INC'
if 'Remarks' in df.columns:
    df['is_inc'] = df['Remarks'].apply(lambda x: 1 if str(x).upper().strip() == 'INC' else 0)
else:
    # Fallback: Random generation for testing if column missing (REMOVE IN PRODUCTION)
    print("Warning: 'Remarks' column not found. Simulating INC data for training...")
    np.random.seed(42)
    df['is_inc'] = np.random.choice([0, 1], size=len(df), p=[0.95, 0.05]) # 5% INC rate

# AGGREGATE DATA (Calculate Rate per Year per College)
# Group by Year and College
grouped = df.groupby(['Year_Numeric', 'College']).agg(
    total_students=('Student_ID', 'nunique'),
    inc_count=('is_inc', 'sum')
).reset_index()

# Calculate Percentage
grouped['INC_Rate'] = (grouped['inc_count'] / grouped['total_students']) * 100

# TRAIN MODEL
# Features: College (One-Hot), Year
X = pd.get_dummies(grouped[['College']], prefix='College')
X['Year_Numeric'] = grouped['Year_Numeric']
y = grouped['INC_Rate']

model = LinearRegression()
model.fit(X, y)

# 5. EVALUATE
y_pred = model.predict(X)
r2 = r2_score(y, y_pred)
mse = mean_squared_error(y, y_pred)

print(f"\nModel Performance:")
print(f" > R² Score: {r2:.4f}")
print(f" > MSE:      {mse:.4f}")

# SAVE
joblib.dump(model, os.path.join(MODEL_DIR, "inc_rate_model.pkl"))
joblib.dump(X.columns.tolist(), os.path.join(MODEL_DIR, "inc_rate_features.pkl"))

print(f"\nSaved to {MODEL_DIR}/")
