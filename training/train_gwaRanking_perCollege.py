import pandas as pd
import numpy as np
import os
import joblib
from sklearn.model_selection import train_test_split
from sklearn.linear_model import LinearRegression
from sklearn.metrics import r2_score, root_mean_squared_error

# 1. SETUP
DATA_PATH = "processed_datasets/Final_Merged_Student_Data.csv"
MODEL_DIR = "Machine_Learning_Model"
os.makedirs(MODEL_DIR, exist_ok=True)

print("--- TRAINING GWA RANKING MODEL (Per College) ---")

if not os.path.exists(DATA_PATH):
    print(f"Error: Dataset not found at {DATA_PATH}")
    exit()

df = pd.read_csv(DATA_PATH)

# 2. DATA CLEANING
df['Year_Numeric'] = df['Year'].astype(str).str.extract(r'(\d{4})')[0].astype(float)

# Semester map: extract first digit
sem_map = {'1': 1, '2': 2, 'SUMMER': 3}
df['Sem_Numeric'] = df['Semester'].astype(str).str.upper().apply(
    lambda x: next((v for k, v in sem_map.items() if k in x), 1)
)

# Filter GWA to valid range (1.0 - 5.0) — removes 0s and outliers
df['GWA'] = pd.to_numeric(df['GWA'], errors='coerce')
df = df.dropna(subset=['GWA', 'College', 'Year_Numeric'])
df = df[(df['GWA'] >= 1.0) & (df['GWA'] <= 5.0)]

print(f" > Valid Data Points: {len(df)}")

# 3. FEATURE ENGINEERING
X = pd.get_dummies(df[['College']], prefix='College', drop_first=False)
X['Year_Numeric'] = df['Year_Numeric'].values
X['Sem_Numeric']  = df['Sem_Numeric'].values
y = df['GWA'].values

joblib.dump(X.columns.tolist(), os.path.join(MODEL_DIR, "gwa_ranking_features_final.pkl"))

# 4. TRAINING
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

model = LinearRegression()
model.fit(X_train, y_train)

# 5. EVALUATION — Linear Regression: RMSE + R²
y_pred = model.predict(X_test)
rmse = np.sqrt(root_mean_squared_error(y_test, y_pred))
r2   = r2_score(y_test, y_pred)

print("\n--- MODEL EVALUATION ---")
print(f" RMSE    = {rmse:.4f}")
print(f" R²      = {r2:.4f}")

# 6. SAVE
joblib.dump(model, os.path.join(MODEL_DIR, "gwa_ranking_model_final.pkl"))
print(f"\n[SUCCESS] Saved model to {MODEL_DIR}/gwa_ranking_model_final.pkl")