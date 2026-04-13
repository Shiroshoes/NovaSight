import pandas as pd
import numpy as np
import os
import joblib
from sklearn.linear_model import LinearRegression
from sklearn.metrics import r2_score, mean_squared_error

# SETUP
DATA_PATH = "processed_datasets/Final_Merged_Student_Data.csv"
MODEL_DIR = "Machine_Learning_Model"
os.makedirs(MODEL_DIR, exist_ok=True)

# LOAD DATA
df = pd.read_csv(DATA_PATH).dropna(subset=['GWA', 'Year', 'Semester', 'College'])

# FEATURE ENGINEERING
# Convert Year range '2022-2023' -> 2022
# We take the first 4 digits to represent the start of the academic year
df['Year_Numeric'] = df['Year'].str.extract('^(\d{4})').astype(int)

# Convert Semester '1sem' -> 1
# Adjust this map if your CSV has different spelling (e.g. '1st Sem')
sem_map = {"1sem": 1, "2sem": 2, "3sem": 3, "Summer": 3}
df['Sem_Numeric'] = df['Semester'].str.lower().map(sem_map).fillna(1) 

# One-hot encode Colleges (so we can predict per dept)
X_cats = pd.get_dummies(df[['College']], drop_first=False)
X = pd.concat([X_cats, df[['Year_Numeric', 'Sem_Numeric']]], axis=1)
y = df['GWA']

# Save features list for API
joblib.dump(X.columns.tolist(), os.path.join(MODEL_DIR, "gwa_trend_features.pkl"))

# TRAIN (Linear Regression for Future Projection)
model = LinearRegression()
model.fit(X, y)

# EVALUATION
y_pred = model.predict(X)
r2 = r2_score(y, y_pred)
mse = mean_squared_error(y, y_pred)

print(f"--- GWA Trend Prediction Model ---")
print(f"R2 Score: {r2:.4f}")
print(f"MSE:      {mse:.4f}")

# SAVE
joblib.dump(model, os.path.join(MODEL_DIR, "gwa_trend_model_final.pkl"))
print("Model saved: gwa_trend_model_final.pkl")
