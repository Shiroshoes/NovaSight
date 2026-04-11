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

print(" TRAINING DROPOUT SPIKE MODEL ")

if not os.path.exists(DATA_PATH):
    print("Error: Dataset not found.")
    exit()

df = pd.read_csv(DATA_PATH)

# PREPROCESSING
df['Year_Numeric'] = df['Year'].astype(str).str.extract(r'^(\d{4})').astype(int)

# IDENTIFY DROPPED STUDENTS
# We look for "DROP", "DROPPED", "FAILED", or "UD" (Unofficially Dropped) in Status/Remarks
target_cols = ['Status', 'Remarks', 'Student_Status']
found_col = None

for col in target_cols:
    if col in df.columns:
        found_col = col
        break

if found_col:
    print(f" > Using '{found_col}' to identify dropouts.")
    # Create binary target: 1 if Dropped, 0 if Active
    df['is_dropped'] = df[found_col].astype(str).str.upper().apply(
        lambda x: 1 if any(s in x for s in ['DROP', 'FAIL', 'UD', 'INACTIVE']) else 0
    )
else:
    print(" > Warning: No Status column found. Generating dummy dropout data for testing.")
    np.random.seed(42)
    df['is_dropped'] = np.random.choice([0, 1], size=len(df), p=[0.9, 0.1]) # 10% drop rate

# AGGREGATE DATA (Rate per Year per College)
grouped = df.groupby(['Year_Numeric', 'College']).agg(
    total=('Student_ID', 'nunique'),
    dropped=('is_dropped', 'sum')
).reset_index()

grouped['Drop_Rate'] = (grouped['dropped'] / grouped['total']) * 100

# TRAIN MODEL
X = pd.get_dummies(grouped[['College']], prefix='College')
X['Year_Numeric'] = grouped['Year_Numeric']
y = grouped['Drop_Rate']

model = LinearRegression()
model.fit(X, y)

# EVALUATE
y_pred = model.predict(X)
r2 = r2_score(y, y_pred)
print(f" > R² Score: {r2:.4f}")

# SAVE
joblib.dump(model, os.path.join(MODEL_DIR, "dropout_spike_model.pkl"))
joblib.dump(X.columns.tolist(), os.path.join(MODEL_DIR, "dropout_spike_features.pkl"))

print("Models saved successfully.")
