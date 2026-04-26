import pandas as pd
import numpy as np
import os
import joblib
from sklearn.linear_model import LinearRegression
from sklearn.metrics import r2_score, root_mean_squared_error

# SETUP
DATA_PATH = "processed_datasets/Final_Merged_Student_Data.csv"
MODEL_DIR = "Machine_Learning_Model"
os.makedirs(MODEL_DIR, exist_ok=True)

# LOAD DATA
df = pd.read_csv(DATA_PATH).dropna(subset=['GWA', 'Year', 'Semester', 'College'])

# Filter GWA to valid range (1.0 - 5.0) — CSV has GWA=0 for dropped students
df['GWA'] = pd.to_numeric(df['GWA'], errors='coerce')
df = df[(df['GWA'] >= 1.0) & (df['GWA'] <= 5.0)]

# FEATURE ENGINEERING
# Year: "2022-2023" -> 2022
df['Year_Numeric'] = df['Year'].astype(str).str.extract(r'^(\d{4})').astype(int)

# FIX: Semester map aligned to actual CSV values ("1sem", "2sem")
sem_map = {"1sem": 1, "1st": 1, "2sem": 2, "2nd": 2, "summer": 3}
df['Sem_Numeric'] = df['Semester'].astype(str).str.lower().apply(
    lambda x: next((v for k, v in sem_map.items() if k in x), 1)
)

# One-hot encode Colleges
X = pd.get_dummies(df[['College']], drop_first=False, prefix='College')
X['Year_Numeric'] = df['Year_Numeric'].values
X['Sem_Numeric']  = df['Sem_Numeric'].values
y = df['GWA'].values

# Save features for API
joblib.dump(X.columns.tolist(), os.path.join(MODEL_DIR, "gwa_trend_features.pkl"))

# TRAIN
model = LinearRegression()
model.fit(X, y)

# EVALUATION — Linear Regression: RMSE + R²
y_pred = model.predict(X)
rmse = np.sqrt(root_mean_squared_error(y, y_pred))
r2   = r2_score(y, y_pred)

print("--- GWA TREND MODEL EVALUATION ---")
print(f" RMSE    = {rmse:.4f}")
print(f" R²      = {r2:.4f}")

# SAVE
joblib.dump(model, os.path.join(MODEL_DIR, "gwa_trend_model_final.pkl"))
print(f"\n[SUCCESS] Model saved: gwa_trend_model_final.pkl")