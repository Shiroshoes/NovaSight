import pandas as pd
import numpy as np
import joblib
import os
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, f1_score

# CONFIGURATION
DATA_PATH = "processed_datasets/Final_Merged_Student_Data.csv"
MODEL_DIR = "Machine_Learning_Model"
os.makedirs(MODEL_DIR, exist_ok=True)

print("--- TRAINING SUBJECT RISK MODEL (Pass / Fail / INC) ---")

if not os.path.exists(DATA_PATH):
    print(f"Error: Dataset not found at {DATA_PATH}")
    exit()

df = pd.read_csv(DATA_PATH)

# 1. PREPROCESSING
df['Year_Numeric'] = df['Year'].astype(str).str.extract(r'^(\d{4})').astype(float)
df['Status']       = df['Status'].astype(str).str.strip().str.upper()

if 'Course_Subject_Name' in df.columns:
    df['Subject'] = df['Course_Subject_Name'].str.upper().str.strip()
elif 'Subject' in df.columns:
    df['Subject'] = df['Subject'].str.upper().str.strip()
else:
    print("Error: Subject column not found.")
    exit()

df['Grade'] = pd.to_numeric(df['Grade'], errors='coerce')
df = df.dropna(subset=['Grade', 'Year_Numeric', 'College', 'Subject', 'Status'])

# 2. CLASSIFICATION TARGET
# FIX: Use Status directly for a classification task (not regressing on grade values)
# 0 = Pass (REGULAR), 1 = INC, 2 = Drop
def label_status(status):
    if "DROP" in status:
        return 2
    if "INC" in status:
        return 1
    return 0

df['Status_Label'] = df['Status'].apply(label_status)

# 3. KEEP TOP SUBJECTS by row volume for statistical reliability
top_subjects = df['Subject'].value_counts().nlargest(60).index.tolist()
df = df[df['Subject'].isin(top_subjects)]
print(f" > Using top {len(top_subjects)} subjects | Rows: {len(df)}")

# 4. FEATURE ENGINEERING
X = pd.get_dummies(df[['College', 'Subject']], prefix=['College', 'Subject'])
X['Year_Numeric'] = df['Year_Numeric'].values
X['Grade']        = df['Grade'].values
y = df['Status_Label'].values

joblib.dump(X.columns.tolist(), os.path.join(MODEL_DIR, "subject_grade_features.pkl"))

# 5. TRAIN / TEST SPLIT
X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, random_state=42, stratify=y
)

# 6. TRAINING — Random Forest Classifier
model = RandomForestClassifier(
    n_estimators=100,
    class_weight='balanced',
    random_state=42
)
model.fit(X_train, y_train)

# 7. EVALUATION — Random Forest: Accuracy + F1
y_pred = model.predict(X_test)
acc = accuracy_score(y_test, y_pred)
f1  = f1_score(y_test, y_pred, average='macro')

print("\n--- MODEL EVALUATION ---")
print(f" F1 Score (Macro)    = {f1:.4f}")
print(f" Prediction Accuracy = {acc:.4f}")

# 8. SAVE
joblib.dump(model, os.path.join(MODEL_DIR, "subject_grade_model.pkl"))
print(f"\n[SUCCESS] Model saved to {MODEL_DIR}/subject_grade_model.pkl")