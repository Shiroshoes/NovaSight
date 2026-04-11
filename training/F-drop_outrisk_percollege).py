import pandas as pd
import numpy as np
import os
import joblib
from sklearn.model_selection import train_test_split
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_squared_error, r2_score

# SETUP
DATA_PATH = "processed_datasets/Final_Merged_Student_Data.csv"
MODEL_DIR = "Machine_Learning_Model"
os.makedirs(MODEL_DIR, exist_ok=True)

df = pd.read_csv(DATA_PATH)

# TARGET ENGINEERING
df['is_drop'] = (df['Status'] == 'Drop').astype(int)

# CLEANING & YEAR PARSING
# Assuming 'Year' is like '2022-2023', we take the first 4 digits as a number
df = df.dropna(subset=['Gender', 'College', 'Year']) 
df['Year_Numeric'] = df['Year'].str.extract('(\d{4})').astype(int)

# FEATURE SELECTION: Gender + College + Year_Numeric
# We keep Gender and College as dummies, but Year_Numeric stays as a single number
X_cats = pd.get_dummies(df[['Gender', 'College']], drop_first=False)
X = pd.concat([X_cats, df[['Year_Numeric']]], axis=1)
y = df['is_drop']

# Save the feature names
joblib.dump(X.columns.tolist(), os.path.join(MODEL_DIR, "model_features_with_year.pkl"))

# SPLIT & TRAIN
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

lr_model = LinearRegression()
lr_model.fit(X_train, y_train)

# EVALUATION
predictions = lr_model.predict(X_test)
mse = mean_squared_error(y_test, predictions)
r2 = r2_score(y_test, predictions)
accuracy = np.mean(np.round(predictions.clip(0, 1)) == y_test)

print("--- Year-Based Dropout Analysis ---")
print(f"R^2 Score: {r2:.4f}")
print(f"MSE:       {mse:.4f}")
print(f"Accuracy:  {accuracy:.2%}")

# SAVE MODEL
joblib.dump(lr_model, os.path.join(MODEL_DIR, "gender_dropout_model_with_year.pkl"))
print(f"\nModel saved with Year Trend capability.")
