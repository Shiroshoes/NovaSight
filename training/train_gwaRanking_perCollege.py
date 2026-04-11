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

df = pd.read_csv(DATA_PATH).dropna(subset=['GWA', 'College', 'Year', 'Semester'])

# FEATURE ENGINEERING
df['Year_Numeric'] = df['Year'].str.extract('(\d{4})').astype(int)

# One-hot encode College and Semester
# drop_first=False is crucial so every college/sem has a weight
X_cats = pd.get_dummies(df[['College', 'Semester']], drop_first=False)
X = pd.concat([X_cats, df[['Year_Numeric']]], axis=1)
y = df['GWA']

# Save features for the API to use
joblib.dump(X.columns.tolist(), os.path.join(MODEL_DIR, "gwa_ranking_features_final.pkl"))

# TRAINING
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

gwa_model = LinearRegression()
gwa_model.fit(X_train, y_train)

# EVALUATION
y_pred = gwa_model.predict(X_test)
mse = mean_squared_error(y_test, y_pred)
mape = np.mean(np.abs((y_test - y_pred) / y_test))
accuracy = (1 - mape) * 100

print(f"--- Final Multi-Filter GWA Model ---")
print(f"MSE: {mse:.4f} | Accuracy: {accuracy:.2f}%")

# SAVE
joblib.dump(gwa_model, os.path.join(MODEL_DIR, "gwa_ranking_model_final.pkl"))
