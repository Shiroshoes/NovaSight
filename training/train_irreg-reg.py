import pandas as pd
import numpy as np
import os
import joblib
from sklearn.model_selection import train_test_split
from sklearn.linear_model import LinearRegression
from sklearn.metrics import r2_score, root_mean_squared_error

# CONFIGURATION
DATA_PATH = "processed_datasets/Final_Merged_Student_Data.csv"
MODEL_DIR = "Machine_Learning_Model"
os.makedirs(MODEL_DIR, exist_ok=True)

print(" TRAINING STATUS FORECAST MODEL (Regular vs Irregular Rate) ")

if not os.path.exists(DATA_PATH):
    print(f"Error: Dataset not found at {DATA_PATH}")
    exit()

df = pd.read_csv(DATA_PATH)

# 1. PREPROCESSING
df['Year_Numeric'] = df['Year'].astype(str).str.extract(r'^(\d{4})').astype(int)
df['Status']       = df['Status'].astype(str).str.strip().str.upper()

# FIX: Semester map aligned to actual CSV values ("1sem", "2sem")
sem_map = {"1sem": 1, "1st": 1, "2sem": 2, "2nd": 2, "summer": 3}
df['Sem_Numeric'] = df['Semester'].astype(str).str.lower().apply(
    lambda x: next((v for k, v in sem_map.items() if k in x), 1)
)

# 2. STUDENT-LEVEL IRREGULARITY FLAG
# A student is IRREGULAR if they have any DROP or INC status in their subjects
print(" > Aggregating Student Data...")
student_df = df.groupby(['Year_Numeric', 'College', 'Sem_Numeric', 'Student_ID']).agg({
    'Status': list
}).reset_index()

def check_irregular(row):
    statuses = [str(s).upper() for s in row['Status']]
    joined = " ".join(statuses)
    return 1 if any(x in joined for x in ['DROP', 'INC']) else 0

student_df['is_irregular'] = student_df.apply(check_irregular, axis=1)

# 3. COHORT AGGREGATION — Irregular Rate % per Year x College x Semester
cohort_data = student_df.groupby(['Year_Numeric', 'College', 'Sem_Numeric']).agg(
    total_students=('Student_ID', 'count'),
    irregular_count=('is_irregular', 'sum')
).reset_index()

cohort_data['Irregular_Rate'] = (cohort_data['irregular_count'] / cohort_data['total_students']) * 100
cohort_data = cohort_data[cohort_data['total_students'] > 10]

print(f" > Training on {len(cohort_data)} cohort samples.")

# 4. FEATURE ENGINEERING
X = pd.get_dummies(cohort_data[['College']], prefix='College')
X['Year_Numeric'] = cohort_data['Year_Numeric'].values
X['Sem_Numeric']  = cohort_data['Sem_Numeric'].values
y = cohort_data['Irregular_Rate'].values

joblib.dump(X.columns.tolist(), os.path.join(MODEL_DIR, "status_forest_features.pkl"))

# 5. TRAINING
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

model = LinearRegression()
model.fit(X_train, y_train)

# 6. EVALUATION — Linear Regression: RMSE + R²
y_pred = model.predict(X_test)
rmse = np.sqrt(root_mean_squared_error(y_test, y_pred))
r2   = r2_score(y_test, y_pred)

print("\n--- MODEL EVALUATION ---")
print(f" RMSE    = {rmse:.4f}")
print(f" R²      = {r2:.4f}")

# 7. SAVE
joblib.dump(model, os.path.join(MODEL_DIR, "status_forest_model.pkl"))
print(f"\n[SUCCESS] Model saved to {MODEL_DIR}/status_forest_model.pkl")