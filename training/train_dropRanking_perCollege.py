import pandas as pd
import numpy as np
import os
import joblib
from sklearn.model_selection import train_test_split
from sklearn.linear_model import LinearRegression 
from sklearn.metrics import r2_score, mean_squared_error

# SETUP
DATA_PATH = "processed_datasets/Final_Merged_Student_Data.csv"
MODEL_DIR = "Machine_Learning_Model"
os.makedirs(MODEL_DIR, exist_ok=True)

df = pd.read_csv(DATA_PATH).dropna(subset=['College', 'Year', 'Semester'])

# TARGET & FEATURE ENGINEERING
df['is_drop'] = (df['Status'] == 'Drop').astype(int)

# Extract 4-digit year (handles formats like "2024" or "2024-2025")
df['Year_Numeric'] = df['Year'].str.extract('(\d{4})').astype(int)

# One-hot encode College AND Semester to link them to your filters
X_cats = pd.get_dummies(df[['College', 'Semester']], drop_first=False)
X = pd.concat([X_cats, df[['Year_Numeric']]], axis=1)
y = df['is_drop']

# Save feature list so the API knows the column order
joblib.dump(X.columns.tolist(), os.path.join(MODEL_DIR, "dropout_ranking_features_final.pkl"))

# TRAINING
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

# Linear Regression is required to project values into 2026-2030
model = LinearRegression()
model.fit(X_train, y_train)

y_pred = model.predict(X_test)
mse = mean_squared_error(y_test, y_pred)
r2 = r2_score(y_test, y_pred)

print(f"--- Evaluation Results ---")
print(f"Mean Squared Error (MSE): {mse:.4f}")
print(f"R-Squared (R2) Score:    {r2:.4f}")

# SAVE
joblib.dump(model, os.path.join(MODEL_DIR, "college_dropout_model_final.pkl"))
print(f"Model saved. Features identified: {X.columns.tolist()}")
