import pandas as pd
import numpy as np
import joblib
import os
from sklearn.linear_model import LinearRegression
from sklearn.metrics import r2_score, mean_squared_error

#  CONFIGURATION 
DATA_PATH = "processed_datasets/Final_Merged_Student_Data.csv"
MODEL_DIR = "Machine_Learning_Model"
os.makedirs(MODEL_DIR, exist_ok=True)

print(" TRAINING DROPOUT SPIKE MODEL (Aggregated Rates) ")

if not os.path.exists(DATA_PATH):
    print(f"Error: Dataset not found at {DATA_PATH}")
    exit()

df = pd.read_csv(DATA_PATH)

# 1. DATA CLEANING
# Fix Year
df['Year_Numeric'] = df['Year'].astype(str).str.extract(r'^(\d{4})').astype(int)

# Fix Status (Standardize to Uppercase)
if 'Status' in df.columns:
    df['Status'] = df['Status'].astype(str).str.strip().str.upper()
else:
    print("Error: 'Status' column missing.")
    exit()

# 2. STUDENT-LEVEL AGGREGATION
# We need to know if a student dropped *any* subject in a specific Year/College context.
print(" > Aggregating by Student...")

# Group by Student + Year + College to handle students who shift colleges or counting per year
student_df = df.groupby(['Student_ID', 'Year_Numeric', 'College'])['Status'].apply(list).reset_index()

# Define Dropout: If "DROP" appears in ANY of their subject statuses for that year
student_df['is_dropout'] = student_df['Status'].apply(
    lambda statuses: 1 if any("DROP" in str(s) for s in statuses) else 0
)

# 3. COHORT AGGREGATION (Calculate Rates)
# Now we group by Year and College to get the % rate
cohort_stats = student_df.groupby(['Year_Numeric', 'College']).agg(
    total_students=('Student_ID', 'count'),
    dropout_count=('is_dropout', 'sum')
).reset_index()

# Calculate Percentage
cohort_stats['Dropout_Rate'] = (cohort_stats['dropout_count'] / cohort_stats['total_students']) * 100

# Remove anomalies (e.g., years with 0 students)
cohort_stats = cohort_stats[cohort_stats['total_students'] > 5]

print(f" > Training Data Points: {len(cohort_stats)} (Years x Colleges)")

# 4. FEATURE ENGINEERING
# Inputs: College (One-Hot) + Year
X = pd.get_dummies(cohort_stats[['College']], prefix='College')
X['Year_Numeric'] = cohort_stats['Year_Numeric']

y = cohort_stats['Dropout_Rate']

# Save Feature List (Critical for API to match columns)
joblib.dump(X.columns.tolist(), os.path.join(MODEL_DIR, "dropout_spike_features.pkl"))

# 5. TRAINING
model = LinearRegression()
model.fit(X, y)

# 6. EVALUATION
y_pred = model.predict(X)
r2 = r2_score(y, y_pred)
mse = mean_squared_error(y, y_pred)

print(f" > R² Score: {r2:.4f}")
print(f" > MSE:      {mse:.4f}")

# 7. SAVE
joblib.dump(model, os.path.join(MODEL_DIR, "dropout_spike_model.pkl"))
print(f"\nModel saved to {MODEL_DIR}/dropout_spike_model.pkl")