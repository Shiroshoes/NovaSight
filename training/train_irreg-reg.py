import pandas as pd
import numpy as np
import os
import joblib
from sklearn.model_selection import train_test_split
from sklearn.linear_model import LinearRegression
from sklearn.metrics import r2_score, mean_squared_error, mean_absolute_error

#  CONFIGURATION 
DATA_PATH = "processed_datasets/Final_Merged_Student_Data.csv"
MODEL_DIR = "Machine_Learning_Model"
os.makedirs(MODEL_DIR, exist_ok=True)

print(" TRAINING STATUS FORECAST MODEL (Regular vs Irregular) ")

if not os.path.exists(DATA_PATH):
    print(f"Error: Dataset not found at {DATA_PATH}")
    exit()

df = pd.read_csv(DATA_PATH)

# 1. PREPROCESSING
# Fix Year: "2022-2023" -> 2022
df['Year_Numeric'] = df['Year'].astype(str).str.extract(r'^(\d{4})').astype(int)

# Fix Semester Map
sem_map = {"1sem": 1, "1st": 1, "2sem": 2, "2nd": 2, "summer": 3}
df['Sem_Numeric'] = df['Semester'].astype(str).str.lower().apply(
    lambda x: next((v for k, v in sem_map.items() if k in x), 1)
)

# 2. DEFINE IRREGULARITY (Student Level)
# Group by Student + Term to check their full load
print(" > Aggregating Student Data...")
student_df = df.groupby(['Year_Numeric', 'College', 'Sem_Numeric', 'Student_ID']).agg({
    'Grade': list,
    'Status': list # Optional: can check status text too
}).reset_index()

# Logic: A student is IRREGULAR if they have any Grade 5.0 (Fail) or 0 (Drop)
# OR if their status says "Dropped" / "Failed"
def check_irregular(row):
    grades = row['Grade']
    # Check Grades
    if 5.0 in grades or 0 in grades or 0.0 in grades:
        return 1
    
    # Optional: Check Status Text if available
    statuses = [str(s).upper() for s in row['Status']]
    if any(x in " ".join(statuses) for x in ['DROP', 'FAIL', 'INC']):
        return 1
        
    return 0 # Regular

student_df['is_irregular'] = student_df.apply(check_irregular, axis=1)

# 3. COHORT AGGREGATION (Target: Irregular Rate %)
# We predict the RATE because student counts vary wildly, but the percentage is more stable for trends.
cohort_data = student_df.groupby(['Year_Numeric', 'College', 'Sem_Numeric']).agg(
    total_students=('Student_ID', 'count'),
    irregular_count=('is_irregular', 'sum')
).reset_index()

cohort_data['Irregular_Rate'] = (cohort_data['irregular_count'] / cohort_data['total_students']) * 100

# Filter out tiny cohorts to improve model quality
cohort_data = cohort_data[cohort_data['total_students'] > 10]

print(f" > Training on {len(cohort_data)} cohort samples.")

# 4. FEATURE ENGINEERING
X = pd.get_dummies(cohort_data[['College']], prefix='College')
X['Year_Numeric'] = cohort_data['Year_Numeric']
X['Sem_Numeric'] = cohort_data['Sem_Numeric']

y = cohort_data['Irregular_Rate']

# Save Feature Columns
joblib.dump(X.columns.tolist(), os.path.join(MODEL_DIR, "status_forest_features.pkl"))

# 5. TRAINING
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

model = LinearRegression()
model.fit(X_train, y_train)

# 6. PREDICTION & EVALUATION
y_pred = model.predict(X_test)

# Metrics
mse = mean_squared_error(y_test, y_pred)
r2 = r2_score(y_test, y_pred)
mae = mean_absolute_error(y_test, y_pred)

# Custom "Accuracy" for Regression (100% - Mean Percentage Error)
# We clamp the error to ensure accuracy isn't negative
mean_p_error = np.mean(np.abs((y_test - y_pred) / y_test)) * 100
accuracy = max(0, 100 - mean_p_error)

print("\n--- MODEL PERFORMANCE ---")
print(f" > MSE (Mean Squared Error): {mse:.4f}")
print(f" > R² Score:                 {r2:.4f}")
print(f" > Prediction Accuracy:      {accuracy:.2f}%")

# 7. SAVE
joblib.dump(model, os.path.join(MODEL_DIR, "status_forest_model.pkl"))
print(f"\nModel saved to {MODEL_DIR}/status_forest_model.pkl")