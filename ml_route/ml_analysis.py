import os
import joblib
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import io
import base64
import traceback
from sklearn.metrics import (
    accuracy_score, f1_score,
    r2_score, root_mean_squared_error
)
from sklearn.model_selection import train_test_split
from flask import Blueprint, jsonify, request

ml_bp = Blueprint('ml_analysis', __name__)

#  GLOBAL DATA LOADING & CLEANING (Run once at startup) 
# This fixes the "No Data" issue by creating the Year_Numeric column right here.
DATA_PATH = "processed_datasets/Final_Merged_Student_Data.csv"
MODEL_DIR = "Machine_Learning_Model"

print(" Loading ML Data & Models ")

# Load Data
if os.path.exists(DATA_PATH):
    try:
        df_full_loaded = pd.read_csv(DATA_PATH)

        # gender
        df_full_loaded['Gender'] = df_full_loaded['Gender'].astype(str).str.strip().str.title()

        #  FIX: DO NOT REMOVE GWA = 0 (important for INC)
        df_full_loaded = df_full_loaded[df_full_loaded['GWA'].notna()].copy()

        # Year extraction
        df_full_loaded['Year_Numeric'] = (
            df_full_loaded['Year']
            .astype(str)
            .str.extract(r'^(\d{4})')[0]
            .astype(float)
        )

        # Semester mapping
        sem_map = {
            "1sem": 1, "1st sem": 1,
            "2sem": 2, "2nd sem": 2,
            "summer": 3
        }

        df_full_loaded['Sem_Numeric'] = (
            df_full_loaded['Semester']
            .astype(str)
            .str.lower()
            .map(sem_map)
            .fillna(1)
        )

        df_full_loaded = df_full_loaded.dropna(subset=['Year_Numeric'])

        print(f" Data Loaded: {len(df_full_loaded)} rows")
        print(f" Unique Students: {df_full_loaded['Student_ID'].nunique()}")

    except Exception as e:
        print(f" Data Load Error: {e}")
        df_full_loaded = pd.DataFrame()
else:
    print(" CSV not found")
    df_full_loaded = pd.DataFrame()

# Load Models
def load_model(filename):
    path = os.path.join(MODEL_DIR, filename)
    return joblib.load(path) if os.path.exists(path) else None
drop_pie_model = load_model("dropout_model.pkl")
drop_pie_features = load_model("dropout_features.pkl")

gwa_ranking_model = load_model("gwa_ranking_model_final.pkl")
gwa_ranking_features = load_model("gwa_ranking_features_final.pkl")

dropout_ranking_model = load_model("college_dropout_model_final.pkl")
dropout_ranking_features = load_model("dropout_ranking_features_final.pkl")

gwa_trend_model = joblib.load(os.path.join("Machine_Learning_Model", "gwa_trend_model_final.pkl"))
gwa_trend_features = joblib.load(os.path.join("Machine_Learning_Model", "gwa_trend_features.pkl"))

kpi_gwa_model = load_model("kpi_gwa_model.pkl")
kpi_gwa_features = load_model("kpi_gwa_features.pkl")

kpi_enroll_model = load_model("kpi_enrollment_model.pkl")
kpi_enroll_features = load_model("kpi_enrollment_features.pkl")

status_model = load_model("status_forest_model.pkl")
status_features = load_model("status_forest_features.pkl")

inc_model = load_model("inc_rate_model.pkl")
inc_features = load_model("inc_rate_features.pkl")

subj_model = load_model("subject_grade_model.pkl")
subj_features = load_model("subject_grade_features.pkl")

dropout_spike_model = load_model("dropout_spike_model.pkl")
dropout_spike_features = load_model("dropout_spike_features.pkl")


# ML piechart (Gender Analysis) 
@ml_bp.route('/api/get_dropout_pie')
def get_dropout_pie():
    try:
        # --- 1. INPUTS ---
        year = int(request.args.get('year', 2024))
        college_arg = request.args.get('college', 'all').strip()
        semester_arg = request.args.get('semester', 'all').strip()

        target_college = 'all' if college_arg.lower() in ['main campus', 'all', ''] else college_arg
        target_sem = 'all' if semester_arg.lower() in ['all', 'overall'] else semester_arg
        
        is_forecast = year > 2024
        mode_label = "Forecast" if is_forecast else "Actual History"

        # --- 2. SELECT COHORT ---
        cohort_year = 2024 if is_forecast else year
        cohort = df_full_loaded[df_full_loaded['Year_Numeric'] == cohort_year].copy()

        if target_college != 'all':
            cohort = cohort[cohort['College'].astype(str).str.upper() == target_college.upper()]
        if target_sem != 'all':
            cohort = cohort[cohort['Semester'].astype(str).str.upper() == target_sem.upper()]

        if cohort.empty:
            return jsonify({"labels": [], "data": [], "total": 0, "mode": mode_label})

        # --- 3. AGGREGATE & NORMALIZE ---
        student_cohort = cohort.groupby("Student_ID").agg({
            "Gender": "first", "College": "first", "Semester": "first", "Grade": list
        }).reset_index()

        def get_numeric_stats(grades):
            clean_g = [float(g) for g in grades if str(g).replace('.','').isdigit()]
            return pd.Series([np.mean(clean_g) if clean_g else 3.0, 
                              np.min(clean_g) if clean_g else 3.0, 
                              len(clean_g)])

        student_cohort[["Avg_Grade", "Min_Grade", "Subject_Count"]] = student_cohort["Grade"].apply(get_numeric_stats)
        
        # STRICT GENDER MAPPING (Male=0, Female=1)
        # CSV stores gender as numeric 0.0/1.0, handle both numeric and string formats
        def map_gender(val):
            try:
                return int(float(val))  # handles 0.0, 1.0, "0", "1"
            except (ValueError, TypeError):
                s = str(val).strip().title()
                return 1 if s == "Female" else 0
        student_cohort["Gender_Code"] = student_cohort["Gender"].apply(map_gender)

        # --- 4. PREDICT OR LABEL ---
        if is_forecast:
            # Apply a realistic grade drift for future years so predictions
            # are not identical to the present-year data.
            # Each year beyond 2024 nudges avg/min grades slightly upward
            # (worse performance trend), which shifts at-risk classification.
            years_ahead = year - 2024
            grade_drift = years_ahead * 0.08   # e.g. +0.08 per year
            drifted_avg = (student_cohort["Avg_Grade"] + grade_drift).clip(upper=5.0)
            drifted_min = (student_cohort["Min_Grade"] + grade_drift * 1.5).clip(upper=5.0)

            X_pred = pd.DataFrame(0, index=np.arange(len(student_cohort)), columns=drop_pie_features)
            X_pred["Year_Numeric"] = year
            X_pred["Gender_Code"] = student_cohort["Gender_Code"].values
            X_pred["Avg_Grade"] = drifted_avg.values
            X_pred["Min_Grade"] = drifted_min.values
            X_pred["Subject_Count"] = student_cohort["Subject_Count"].values

            for col in drop_pie_features:
                if col.startswith("College_"):
                    c_name = col.replace("College_", "")
                    X_pred[col] = (student_cohort["College"] == c_name).astype(int).values
                if col.startswith("Semester_"):
                    s_name = col.replace("Semester_", "")
                    X_pred[col] = (student_cohort["Semester"] == s_name).astype(int).values

            student_cohort["Status_Label"] = drop_pie_model.predict(X_pred)
        else:
            def get_history_label(grades):
                g = [float(x) for x in grades if str(x).replace('.','').isdigit()]
                if not g: return 0
                if any(v in [0.0, 9.0] for v in g): return 2 # Drop
                if any(v in [5.0, 8.0] for v in g): return 1 # INC
                return 0
            student_cohort["Status_Label"] = student_cohort["Grade"].apply(get_history_label)

        # --- 5. THE 6-WAY COUNT ---
        # Map values locally to ensure Female is visible
        df_f = student_cohort
        
        df_f["Gender_Int"] = pd.to_numeric(df_f["Gender"], errors='coerce').fillna(0).astype(int)
        
        counts = [
            len(df_f[(df_f.Gender_Code == 0) & (df_f.Status_Label == 0)]), # [0] M-Regular
            len(df_f[(df_f.Gender_Code == 0) & (df_f.Status_Label == 1)]), # [1] M-INC
            len(df_f[(df_f.Gender_Code == 0) & (df_f.Status_Label == 2)]), # [2] M-Drop
            len(df_f[(df_f.Gender_Code == 1) & (df_f.Status_Label == 0)]), # [3] F-Regular
            len(df_f[(df_f.Gender_Code == 1) & (df_f.Status_Label == 1)]), # [4] F-INC
            len(df_f[(df_f.Gender_Code == 1) & (df_f.Status_Label == 2)])  # [5] F-Drop
        ]

        return jsonify({
            "labels": ["Male Regular", "Male INC", "Male Drop", "Female Regular", "Female INC", "Female Drop"],
            "data": counts,
            "colors": ["#4e73df", "#f6c23e", "#e74a3b", "#d84a85", "#fd7e14", "#858796"],
            "total": int(len(df_f)),
            "mode": mode_label,
            "display_college": target_college.upper(),
            "display_sem": target_sem.upper()
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500




    




# GWA RANKING (Bar Chart) 
@ml_bp.route('/api/get_gwa_ranking_data/<int:selected_year>')
def get_gwa_ranking_data(selected_year):
    try:
        
        # Inputs
        sel_sem = request.args.get('semester', 'all')
        # Note: GWA Ranking usually compares ALL colleges, so 'sel_college' is unused for filtering,
        # but we parse it just in case specific highlighting is needed later.
        
        # Mode Logic
        LATEST_REAL_YEAR = 2024
        is_forecast = selected_year > LATEST_REAL_YEAR

        results = []

        # Get List of Colleges
        if 'College' not in df_full_loaded.columns:
             return jsonify({"error": "Data missing College column"}), 500
        
        all_colleges = df_full_loaded['College'].dropna().unique().tolist()
        all_colleges = [str(c).strip().upper() for c in all_colleges if str(c).strip() != '']
        all_colleges = list(set(all_colleges))

        # --- A. FORECAST MODE (AI) ---
        if is_forecast and gwa_ranking_model:
            # Map Semester to Numeric (Average = 1.5)
            sem_val = 1.5
            if '1' in sel_sem: sem_val = 1
            elif '2' in sel_sem: sem_val = 2
            elif 'summer' in sel_sem.lower(): sem_val = 3

            for college in all_colleges:
                # Init Input Vector
                input_data = pd.DataFrame(0, index=[0], columns=gwa_ranking_features)
                input_data['Year_Numeric'] = selected_year
                input_data['Sem_Numeric'] = sem_val
                
                # Set College Feature
                col_feat = f"College_{college}"
                if col_feat in gwa_ranking_features:
                    input_data[col_feat] = 1
                
                try:
                    pred_gwa = gwa_ranking_model.predict(input_data)[0]
                    # Clamp to valid 1.0 - 5.0 range
                    final_gwa = round(max(1.0, min(5.0, pred_gwa)), 2)
                    results.append({"college": college, "gwa": final_gwa})
                except:
                    results.append({"college": college, "gwa": 0})

        # --- B. HISTORICAL MODE (Actuals) ---
        else:
            cohort = df_full_loaded[df_full_loaded['Year_Numeric'] == selected_year].copy()
            
            # Filter Semester
            if sel_sem.lower() not in ['all', 'overall']:
                cohort = cohort[cohort['Semester'].astype(str).str.contains(sel_sem, case=False, na=False)]

            for college in all_colleges:
                c_data = cohort[cohort['College'].str.upper() == college]
                
                if not c_data.empty:
                    # Filter valid grades only (1.0 - 5.0)
                    c_data['GWA'] = pd.to_numeric(c_data['GWA'], errors='coerce')
                    valid_gwa = c_data[(c_data['GWA'] >= 1.0) & (c_data['GWA'] <= 5.0)]
                    
                    if not valid_gwa.empty:
                        avg_gwa = round(valid_gwa['GWA'].mean(), 2)
                    else:
                        avg_gwa = 0
                else:
                    avg_gwa = 0
                
                results.append({"college": college, "gwa": avg_gwa})

        # 4. SORTING
        # For GWA, 1.0 is Best. Sort Ascending so Best is First.
        results = sorted(results, key=lambda x: x['gwa'] if x['gwa'] > 0 else 99, reverse=False)

        return jsonify(results)

    except Exception as e:
        print(f"GWA Ranking Error: {e}")
        return jsonify({"error": str(e)}), 500
    


# DROPOUT RANKING (Bar Chart) 
@ml_bp.route('/api/get_dropout_ranking')
def get_dropout_ranking():
    try:

        # 1. INPUTS
        year = int(request.args.get('year', 2024))
        semester_arg = request.args.get('semester', 'all').strip()

        # 2. MODE
        LATEST_REAL_YEAR = 2024
        is_forecast = year > LATEST_REAL_YEAR

        # 3. GET COLLEGES
        if 'College' not in df_full_loaded.columns:
             return jsonify({"error": "College column missing"}), 500
             
        all_colleges = df_full_loaded['College'].dropna().unique().tolist()
        # Clean list
        all_colleges = [str(c).strip().upper() for c in all_colleges if str(c).strip() != '']
        all_colleges = list(set(all_colleges)) 

        results = []

        # --- A. FORECAST MODE (AI Prediction 2026-2030) ---
        if is_forecast and 'dropout_ranking_model' in globals() and dropout_ranking_model:
            for college in all_colleges:
                # Init Input Vector
                input_data = pd.DataFrame(0, index=[0], columns=dropout_ranking_features)
                input_data['Year_Numeric'] = year
                
                # Map College
                col_feat = f"College_{college}"
                if col_feat in dropout_ranking_features: input_data[col_feat] = 1
                
                # Map Semester
                target_sem = "1ST SEMESTER" if semester_arg == 'all' else semester_arg.upper()
                for feat in dropout_ranking_features:
                    if "Semester_" in feat and target_sem in feat.upper():
                        input_data[feat] = 1
                        break

                try:
                    pred_prob = dropout_ranking_model.predict(input_data)[0]
                    pred_pct = round(max(0, pred_prob * 100), 2) 
                    results.append({"college": college, "rate": pred_pct})
                except:
                    results.append({"college": college, "rate": 0})

        # --- B. HISTORICAL MODE (Actual Data) ---
        else:
            # Filter Year
            # (Year_Numeric created in global load)
            cohort = df_full_loaded[df_full_loaded['Year_Numeric'] == year].copy()

            # Clean Status Column
            if 'Status' in cohort.columns:
                cohort['Status'] = cohort['Status'].astype(str).str.strip().str.upper()
            else:
                cohort['Status'] = "UNKNOWN"

            # Filter Semester
            if semester_arg.lower() not in ['all', 'overall']:
                cohort = cohort[cohort['Semester'].astype(str).str.upper().str.contains(semester_arg.upper(), na=False)]

            # Calculate Rates
            for college in all_colleges:
                c_data = cohort[cohort['College'].astype(str).str.strip().str.upper() == college]
                
                # Count Total Unique Students
                total_students = c_data['Student_ID'].nunique()
                
                if total_students > 0:
                    # === FIX: VECTORIZED STATUS SEARCH ===
                    # 1. Find rows with "DROP" in status
                    drop_rows = c_data[c_data['Status'].str.contains("DROP", na=False)]
                    
                    # 2. Count Unique Student IDs (People)
                    drop_count = drop_rows['Student_ID'].nunique()
                    
                    rate = round((drop_count / total_students) * 100, 2)
                else:
                    rate = 0
                
                results.append({"college": college, "rate": rate})

        # 4. SORT RESULTS
        results = sorted(results, key=lambda x: x['rate'], reverse=True)

        return jsonify({
            "data": results,
            "mode": "Forecast" if is_forecast else "Actual History",
            "year": year
        })

    except Exception as e:
        print(f"Dropout Ranking Error: {e}")
        return jsonify({"error": str(e)}), 500





# GWA TREND (Scatter Plot) 
@ml_bp.route('/api/get_gwa_scatter')
def get_gwa_scatter():
    try:
        # 1. INPUTS
        year = int(request.args.get('year', 2024))
        college_arg = request.args.get('college', 'all').strip()
        semester = request.args.get('semester', 'all').strip()

        # Normalize
        if college_arg.lower() in ['main campus', 'overall', 'all', '']:
            target_college = 'all'
        else:
            target_college = college_arg

        # 2. DETERMINE MODE (History vs Future)
        LATEST_REAL_YEAR = 2024
        is_forecast = year > LATEST_REAL_YEAR
        
        # 3. DATA LOADING (The Dots)
        # For History: Use the requested year.
        # For Forecast: Use the Latest Cohort (2024) as a visual proxy for the population.
        target_data_year = LATEST_REAL_YEAR if is_forecast else year
        
        if 'Year_Numeric' not in df_full_loaded.columns:
            df_full_loaded['Year_Numeric'] = (
                df_full_loaded['Year'].astype(str)
                .str.extract(r'^(\d{4})')[0]
                .fillna(0).astype(int)
            )

        cohort = df_full_loaded[df_full_loaded['Year_Numeric'] == target_data_year].copy()

        # 4. FILTERING
        if target_college != 'all':
            cohort = cohort[
                cohort['College'].astype(str).str.strip().str.upper() == target_college.upper()
            ]
        
        if semester.lower() not in ['all', 'overall']:
            cohort = cohort[
                cohort['Semester'].astype(str).str.strip().str.upper() == semester.upper()
            ]

        # 5. VALIDATION (Filter valid GWA 1.0-5.0)
        cohort['GWA'] = pd.to_numeric(cohort['GWA'], errors='coerce')
        valid_data = cohort[(cohort['GWA'] >= 1.0) & (cohort['GWA'] <= 5.0)].copy()

        # 6. CALCULATE AVERAGE LINE
        batch_average = 0
        
        if is_forecast and gwa_trend_model:
            # --- AI PREDICTION FOR THE RED LINE ---
            # Prepare a single input row for the model
            X_pred = pd.DataFrame(0, index=[0], columns=gwa_trend_features)
            
            # Set Year
            X_pred['Year_Numeric'] = year 
            
            # Set Semester (Map text to number)
            if '1' in semester: sem_val = 1
            elif '2' in semester: sem_val = 2
            else: sem_val = 1.5
            X_pred['Sem_Numeric'] = sem_val
            
            # Set College (One-Hot)
            if target_college != 'all':
                for col in gwa_trend_features:
                    if target_college.upper() in col.upper():
                        X_pred[col] = 1
                        break
            
            # Predict the Average
            pred_val = gwa_trend_model.predict(X_pred)[0]
            batch_average = round(pred_val, 2)
            line_label = f"Predicted Avg ({batch_average})"
            
        else:
            # --- REAL HISTORICAL AVERAGE ---
            if not valid_data.empty:
                batch_average = round(valid_data['GWA'].mean(), 2)
            line_label = f"Batch Avg ({batch_average})"

        # 7. PREPARE DOTS (Sampled & Jittered)
        if len(valid_data) > 800:
            valid_data = valid_data.sample(n=800, random_state=42)
        
        valid_data['jitter_x'] = np.random.uniform(0.5, 3.5, size=len(valid_data))

        scatter_points = []
        for _, row in valid_data.iterrows():
            scatter_points.append({
                "x": round(row['jitter_x'], 2),
                "y": round(row['GWA'], 2),
                "student_id": str(row['Student_ID'])[:4] + "-***" 
            })

        return jsonify({
            "data": scatter_points,
            "average": batch_average,
            "line_label": line_label, # Send the label dynamically
            "count": len(scatter_points)
        })

    except Exception as e:
        print(f"GWA Scatter Error: {e}")
        return jsonify({"error": str(e)}), 500
    



# KPI METRICS (Actual vs Predicted)
@ml_bp.route('/api/get_kpi_metrics')
def get_kpi_metrics():
    try:
        # Parse Inputs
        year = int(request.args.get('year', 2024))
        semester = request.args.get('semester', 'all')
        college = request.args.get('college', 'all')
        
        # Define "Future" Boundary
        CURRENT_YEAR = 2024 
        is_prediction = year > CURRENT_YEAR

        # SCENARIO A: ACTUAL DATA (Historical)
        if not is_prediction:
            # Filter Global Data
            df_scope = df_full_loaded.copy()
            
            # Filter by College
            if college != 'all':
                df_scope = df_scope[df_scope['College'] == college]
            
            # Filter by Year
            df_scope = df_scope[df_scope['Year_Numeric'] == year]
            
            # Filter by Semester (Optional for Student Count, Important for GWA)
            # Note: Usually enrollment is counted per year, but GWA varies by sem.
            if semester != 'all':
                sem_val = 1 if '1' in semester else 2
                df_scope = df_scope[df_scope['Sem_Numeric'] == sem_val]

            if df_scope.empty:
                return jsonify({"students": 0, "gwa": 0, "is_prediction": False})
            
            total_students = int(df_scope['Student_ID'].nunique())
            avg_gwa = round(df_scope['GWA'].mean(), 2)

        # SCENARIO B: PREDICTIVE DATA (Future AI)
        else:
            # We need to predict for specific colleges.
            # If 'all' is selected, we predict for EVERY college and sum/average the results.
            
            # 1. Identify which colleges to predict for
            colleges_to_process = []
            if college != 'all':
                colleges_to_process = [college]
            else:
                # Extract college names from the One-Hot features (e.g., 'College_CCST')
                colleges_to_process = [feat.replace('College_', '') for feat in kpi_enroll_features if feat.startswith('College_')]

            total_students_accum = 0
            gwa_accum = []

            for col_name in colleges_to_process:
                # A. Predict Enrollment
                # Build Feature Vector
                X_enroll = pd.DataFrame(np.zeros((1, len(kpi_enroll_features))), columns=kpi_enroll_features)
                X_enroll['Year_Numeric'] = year
                
                # Set College Bit
                col_feat = f"College_{col_name}"
                if col_feat in kpi_enroll_features:
                    X_enroll[col_feat] = 1
                
                pred_count = int(kpi_enroll_model.predict(X_enroll)[0])
                total_students_accum += max(0, pred_count) # Add to total

                # B. Predict GWA
                # If semester is 'all', we predict Sem 1 & Sem 2 and average them
                sem_loop = [1, 2] if semester == 'all' else [1] if '1' in semester else [2]
                
                for s in sem_loop:
                    X_gwa = pd.DataFrame(np.zeros((1, len(kpi_gwa_features))), columns=kpi_gwa_features)
                    X_gwa['Year_Numeric'] = year
                    X_gwa['Sem_Numeric'] = s
                    
                    if col_feat in kpi_gwa_features:
                        X_gwa[col_feat] = 1
                    
                    pred_grade = float(kpi_gwa_model.predict(X_gwa)[0])
                    gwa_accum.append(pred_grade)

            # Final Calculation
            total_students = total_students_accum
            avg_gwa = round(sum(gwa_accum) / len(gwa_accum), 2) if gwa_accum else 0

        return jsonify({
            "students": total_students,
            "gwa": avg_gwa,
            "is_prediction": is_prediction,
            "year": year
        })

    except Exception as e:
        print(f"KPI Error: {e}")
        return jsonify({"students": 0, "gwa": 0, "error": str(e)}), 500




# piechart
@ml_bp.route('/api/get_status_distribution')
def get_status_distribution():
    try:
        # Inputs
        year = int(request.args.get('year', 2024))
        semester = request.args.get('semester', 'all')
        college = request.args.get('college', 'all')

        print(f"\n--- DEBUG: STATUS DISTRIBUTION ({college}) ---")

        # Data Safety & Virtual Cohort
        if 'Year_Numeric' not in df_full_loaded.columns:
            df_full_loaded['Year_Numeric'] = df_full_loaded['Year'].astype(str).str.extract(r'^(\d{4})').astype(int)
        
        # Use 2024 as the base population
        base_df = df_full_loaded[df_full_loaded['Year_Numeric'] == 2024].copy()
        
        # Filter by College
        if college != 'all':
            # FILTER LOGIC: Normalize strings to ensure match
            # This handles "CAHS" vs "cahs" vs " CAHS "
            base_df = base_df[base_df['College'].str.strip().str.upper() == college.strip().upper()]

        print(f" > Students Found: {len(base_df)}")
        
        if base_df.empty:
            print(" > WARNING: No students found. Check CSV Spelling vs College Variable.")
            return jsonify({"labels": ["No Data"], "data": [0, 0, 0], "colors": ["#ccc"], "year": year, "total": 0})

        # Build Prediction Features
        X_pred = pd.DataFrame(0, index=np.arange(len(base_df)), columns=status_features)
        X_pred['Year_Numeric'] = year
        X_pred['Sem_Numeric'] = 1 if '1' in semester else 2

        # ROBUST MAPPING (The Fix)
        # We iterate through the specific college features the model knows
        matched_count = 0
        for feat in status_features:
            if feat.startswith('College_'):
                # Extract model's expected name (e.g., "CAHS" from "College_CAHS")
                model_col_name = feat.replace('College_', '').strip().upper()
                
                # Check against CSV data (Case Insensitive)
                # We find rows where CSV College matches the Model Feature
                mask = base_df['College'].str.strip().str.upper() == model_col_name
                
                if mask.any():
                    X_pred.loc[mask.values, feat] = 1
                    matched_count += 1
        
        print(f" > Colleges Matched in Model: {matched_count}")
        if matched_count == 0 and college != 'all':
            print(f" > CRITICAL ERROR: Model does not have a feature for '{college}'.") 
            print(f" > Available Model Features: {[f for f in status_features if 'College_' in f]}")

        # Predict
        predicted_gwas = status_model.predict(X_pred)

        high = int(np.sum(predicted_gwas >= 950))
        average = int(np.sum((predicted_gwas >= 900) & (predicted_gwas < 950)))
        risk = int(np.sum(predicted_gwas < 900))
        
        print(f" > Prediction: High={high}, Avg={average}, Risk={risk}")

        return jsonify({
            "labels": ["High (≥950)", "Average (900-949)", "At-Risk (<900)"],
            "data": [high, average, risk],
            "colors": ["#1cc88a", "#f6c23e", "#e74a3b"], 
            "year": year,
            "total": high + average + risk
        })

    except Exception as e:
        print(f" Status Error: {e}")
        return jsonify({"error": str(e)}), 500
    



# inc forecast
@ml_bp.route('/api/get_inc_forecast')
def get_inc_forecast():
    try:
        import pandas as pd
        
        # 1. INPUTS
        college = request.args.get('college', 'all').strip()
        
        # 2. HISTORY (Actual Calculation using Status)
        df_scope = df_full_loaded.copy()
        
        if college.lower() not in ['all', 'main campus']:
            df_scope = df_scope[df_scope['College'].str.upper() == college.upper()]
        
        # Calculate Rate per Year
        years = sorted(df_scope['Year_Numeric'].unique())
        history_data = []
        
        for yr in years:
            yr_df = df_scope[df_scope['Year_Numeric'] == yr]
            total = yr_df['Student_ID'].nunique()
            
            if total > 0:
                # Count students with ANY 'INC' status
                inc_students = yr_df[yr_df['Status'].astype(str).str.contains('INC', case=False, na=False)]['Student_ID'].nunique()
                rate = (inc_students / total) * 100
                history_data.append(round(rate, 2))
            else:
                history_data.append(0)

        # 3. FORECAST (Using Model)
        forecast_years = [2025, 2026, 2027, 2028]
        forecast_data = []
        
        if inc_model:
            # Identify College Feature
            col_feat = f"College_{college.upper()}" if college.lower() != 'all' else None
            
            for yr in forecast_years:
                X_in = pd.DataFrame(0, index=[0], columns=inc_features)
                X_in['Year_Numeric'] = yr
                if col_feat and col_feat in inc_features:
                    X_in[col_feat] = 1
                
                try:
                    pred = float(inc_model.predict(X_in)[0])
                    forecast_data.append(round(max(0, pred), 2))
                except:
                    forecast_data.append(0)
        else:
            forecast_data = [0] * len(forecast_years)

        return jsonify({
            "years": [int(y) for y in years] + forecast_years,
            "history": history_data,
            "forecast": forecast_data
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500





#subject top
@ml_bp.route('/api/get_subject_forecast')
def get_subject_forecast():
    try:
        college = request.args.get('college', 'all').strip()
        
        # 1. PREPARE DATA
        df_scope = df_full_loaded.copy()
        
        # Normalize Subject Names to avoid "Calculus 1" vs "calculus 1" duplicates
        if 'Course_Subject_Name' in df_scope.columns:
            df_scope['Subject'] = df_scope['Course_Subject_Name'].astype(str).str.upper().str.strip()
        else:
            return jsonify({"error": "Subject column missing"})

        # Filter by College
        if college.lower() not in ['all', 'main campus']:
            df_scope = df_scope[df_scope['College'].astype(str).str.upper() == college.upper()]

        # 2. IDENTIFY TOP 5 HARDEST SUBJECTS
        # Convert Grades
        df_scope['Grade'] = pd.to_numeric(df_scope['Grade'], errors='coerce')
        valid = df_scope[(df_scope['Grade'] >= 1.0) & (df_scope['Grade'] <= 5.0)]
        
        if valid.empty:
            return jsonify({"labels": [], "datasets": [], "error": "No valid grade data found"})

        # Sort by Average Grade (Descending = Hardest)
        difficulty = valid.groupby('Subject')['Grade'].mean().sort_values(ascending=False)
        top_subjects = difficulty.head(5).index.tolist()

        # 3. BUILD TIMELINE (2022-2028)
        years_hist = [2022, 2023, 2024]
        years_pred = [2025, 2026, 2027, 2028, 2029, 2030]
        all_years = years_hist + years_pred
        
        datasets = []
        
        for subj in top_subjects:
            data_points = []
            # Get overall average for this subject (Fallback for gaps)
            overall_avg = difficulty[subj]
            
            # --- A. HISTORY (2022-2024) ---
            for y in years_hist:
                # Strict filter for Year + Subject
                mask = (df_scope['Year_Numeric'] == y) & (df_scope['Subject'] == subj)
                val = df_scope[mask]['Grade'].mean()
                
                if pd.notna(val):
                    data_points.append(round(val, 2))
                else:
                    # GAP FILLER: Use overall average so the line doesn't break
                    data_points.append(round(overall_avg, 2))

            # --- B. FORECAST (2025-2028) ---
            if subj_model:
                # Get last known value for continuity
                last_val = data_points[-1]
                
                for y in years_pred:
                    X_in = pd.DataFrame(0, index=[0], columns=subj_features)
                    X_in['Year_Numeric'] = y
                    
                    # College Feature
                    if college.lower() != 'all':
                        col_feat = f"College_{college.upper()}"
                        if col_feat in subj_features: X_in[col_feat] = 1
                    
                    # Subject Feature
                    subj_feat = f"Subject_{subj}"
                    if subj_feat in subj_features:
                        X_in[subj_feat] = 1
                        try:
                            pred = subj_model.predict(X_in)[0]
                            # Smoothing: Average prediction with last value to prevent erratic jumps
                            smooth_pred = (pred + last_val) / 2
                            final_val = round(max(1.0, min(5.0, smooth_pred)), 2)
                            data_points.append(final_val)
                            last_val = final_val
                        except:
                            data_points.append(last_val) # Carry forward
                    else:
                        # If model doesn't know subject, flatline forecast
                        data_points.append(last_val)
            else:
                # No model? Just flatline
                last = data_points[-1] if data_points else 0
                data_points.extend([last] * 4)

            datasets.append({
                "label": subj,
                "data": data_points
            })

        return jsonify({
            "labels": all_years,
            "datasets": datasets,
            "college": college
        })

    except Exception as e:
        print(f"Subject Forecast Error: {e}")
        return jsonify({"error": str(e)}), 500





#drop spike
@ml_bp.route('/api/get_dropout_spike')
def get_dropout_spike():
    try:

        # 1. INPUT
        college = request.args.get('college', 'all').strip()
        
        # 2. LOAD DATA
        local_df = df_full_loaded.copy()
        
        # Ensure Status Column
        if 'Status' not in local_df.columns:
             return jsonify({"error": "Status column missing"}), 500
        local_df['Status'] = local_df['Status'].astype(str).str.strip().str.upper()

        # Filter College
        if college.lower() not in ['all', 'main campus']:
            local_df = local_df[local_df['College'].astype(str).str.strip().str.upper() == college.upper()]

        # 3. HISTORY (2020 - 2024)
        if 'Year_Numeric' not in local_df.columns:
             local_df['Year_Numeric'] = local_df['Year'].astype(str).str.extract(r'^(\d{4})').astype(int)
        
        years_hist = sorted(local_df['Year_Numeric'].unique())
        data_points = []
        
        for yr in years_hist:
            yr_df = local_df[local_df['Year_Numeric'] == yr]
            total = yr_df['Student_ID'].nunique()
            
            if total > 0:
                # Vectorized Student-Level Count
                drop_rows = yr_df[yr_df['Status'].str.contains("DROP", na=False)]
                drop_count = drop_rows['Student_ID'].nunique()
                rate = (drop_count / total) * 100
                data_points.append(round(rate, 2))
            else:
                data_points.append(0)

        # 4. PREDICTION (2025 - 2030)
        # Added 2025 to ensure continuity from 2024
        years_pred = [2025, 2026, 2027, 2028, 2029, 2030]
        
        # Filter out years we already have in history to avoid overlap
        last_hist_year = years_hist[-1] if years_hist else 2024
        years_pred = [y for y in years_pred if y > last_hist_year]

        if dropout_spike_model:
            # Identify College Feature
            target_col_feat = None
            if college.lower() != 'all':
                target_col_feat = f"College_{college.upper()}"

            for yr in years_pred:
                X_in = pd.DataFrame(0, index=[0], columns=dropout_spike_features)
                X_in['Year_Numeric'] = yr
                if target_col_feat and target_col_feat in dropout_spike_features:
                    X_in[target_col_feat] = 1
                
                try:
                    pred = float(dropout_spike_model.predict(X_in)[0])
                    data_points.append(round(max(0, pred), 2))
                except:
                    data_points.append(0)
        else:
            data_points.extend([0] * len(years_pred))

        all_years = [int(y) for y in list(years_hist) + years_pred]
        
        # Find index where prediction starts (for JS dashed line)
        pred_start_index = len(years_hist) - 1 

        # 5. SPIKE DETECTION
        spikes = []
        for i in range(len(data_points)):
            if i == 0:
                spikes.append(False)
            else:
                prev = data_points[i-1]
                curr = data_points[i]
                # Spike logic: 10% relative increase or raw jump > 5%
                is_spike = False
                if prev > 0:
                    if ((curr - prev) / prev) > 0.15: is_spike = True
                elif curr > 5: 
                    is_spike = True
                spikes.append(is_spike)

        return jsonify({
            "labels": all_years,
            "data": data_points,
            "spikes": spikes,
            "pred_start_index": pred_start_index # Send to JS
        })

    except Exception as e:
        print(f"Dropout Spike Error: {e}")
        return jsonify({"error": str(e)}), 500
    



# Irreg multiline
@ml_bp.route('/api/get_status_pie')
def get_status_pie():
    try:
        # 1. INPUTS
        year = int(request.args.get('year', 2024))
        college_arg = request.args.get('college', 'all').strip()
        semester_arg = request.args.get('semester', 'all').strip()

        # 2. MODE
        LATEST_REAL_YEAR = 2024
        is_forecast = year > LATEST_REAL_YEAR

        regular_count = 0
        irregular_count = 0

        # --- HELPER: Filter Data ---
        def get_filtered_data(target_year):
            df = df_full_loaded.copy()
            if 'Year_Numeric' in df.columns:
                df = df[df['Year_Numeric'] == target_year]
            
            if college_arg.lower() not in ['all', 'main campus']:
                df = df[df['College'].str.upper() == college_arg.upper()]
            
            if semester_arg.lower() not in ['all', 'overall']:
                df = df[df['Semester'].astype(str).str.contains(semester_arg, case=False, na=False)]
            return df

        # --- A. FORECAST MODE ---
        if is_forecast:
            # 1. Predict Rate (%)
            pred_rate = 0
            if status_model and status_features:
                # Build Input Vector
                X_in = pd.DataFrame(0, index=[0], columns=status_features)
                X_in['Year_Numeric'] = year
                
                # Map Semester
                sem_val = 1.5 # Default
                if '1' in semester_arg: sem_val = 1
                elif '2' in semester_arg: sem_val = 2
                elif 'summer' in semester_arg.lower(): sem_val = 3
                
                if 'Sem_Numeric' in status_features:
                    X_in['Sem_Numeric'] = sem_val
                
                # Map College
                if college_arg.lower() not in ['all', 'main campus']:
                    col_feat = f"College_{college_arg.upper()}"
                    if col_feat in status_features:
                        X_in[col_feat] = 1
                
                try:
                    # Predict and Clamp (0-100%)
                    pred_rate = float(status_model.predict(X_in)[0])
                    pred_rate = max(0, min(100, pred_rate))
                except:
                    pred_rate = 0

            # 2. Estimate Population (Baseline = Last Actual Year)
            last_cohort = get_filtered_data(LATEST_REAL_YEAR)
            base_pop = last_cohort['Student_ID'].nunique()
            
            if base_pop == 0: base_pop = 100 # Fallback

            # 3. Calculate Counts
            irregular_count = int(base_pop * (pred_rate / 100))
            regular_count = int(base_pop - irregular_count)

        # --- B. HISTORICAL MODE ---
        else:
            cohort = get_filtered_data(year)
            
            if not cohort.empty:
                # Check for Irregularity (Grade 5.0, 0.0, or Status DROP/FAIL)
                def check_status(group):
                    grades = pd.to_numeric(group['Grade'], errors='coerce').fillna(-1).tolist()
                    if 5.0 in grades or 0.0 in grades or 0 in grades:
                        return 1
                    if 'Status' in group.columns:
                        statuses = " ".join(group['Status'].astype(str).str.upper().tolist())
                        if any(x in statuses for x in ['DROP', 'FAIL', 'INC', 'IRREG']):
                            return 1
                    return 0

                irreg_flags = cohort.groupby('Student_ID').apply(check_status)
                irregular_count = int(irreg_flags.sum())
                regular_count = int(len(irreg_flags) - irregular_count)

        # Final Data
        total = regular_count + irregular_count
        reg_pct = round((regular_count / total * 100), 1) if total > 0 else 0
        irr_pct = round((irregular_count / total * 100), 1) if total > 0 else 0

        return jsonify({
            "labels": ["Regular", "Irregular"],
            "data": [regular_count, irregular_count],
            "colors": ["#1cc88a", "#e74a3b"], 
            "percentages": [reg_pct, irr_pct],
            "year": year,
            "mode": "Forecast" if is_forecast else "Actual"
        })

    except Exception as e:
        print(f"Status Pie Error: {e}")
        return jsonify({"error": str(e)}), 500
    










# metrics evaluation
@ml_bp.route('/api/get_model_metrics')
def get_model_metrics():
    try:
        if df_full_loaded.empty:
            return jsonify({"error": "Dataset not loaded"}), 500
 
        results = []
 
        # ── Helper ──────────────────────────────────────────────
        def reg_metrics(model, feats, X, y, name, description):
            """Evaluate a regression model and append to results."""
            try:
                if model is None or feats is None:
                    raise ValueError("Model or features not loaded")
                X_aligned = X.reindex(columns=feats, fill_value=0)
                y_pred = model.predict(X_aligned)
                rmse = float(np.sqrt(root_mean_squared_error(y, y_pred)))
                r2   = float(r2_score(y, y_pred))
                results.append({
                    "name": name,
                    "description": description,
                    "type": "regression",
                    "metrics": {"RMSE": round(rmse, 4), "R²": round(r2, 4)},
                    "status": "ok"
                })
            except Exception as e:
                results.append({"name": name, "description": description,
                                "type": "regression", "metrics": {},
                                "status": "error", "error": str(e)})
 
        def clf_metrics(model, feats, X, y, name, description):
            """Evaluate a classification model and append to results."""
            try:
                if model is None or feats is None:
                    raise ValueError("Model or features not loaded")
                X_aligned = X.reindex(columns=feats, fill_value=0)
                y_pred = model.predict(X_aligned)
                acc = float(accuracy_score(y, y_pred))
                f1  = float(f1_score(y, y_pred, average='macro', zero_division=0))
                results.append({
                    "name": name,
                    "description": description,
                    "type": "classification",
                    "metrics": {
                        "Accuracy": round(acc, 4),
                        "F1 (Macro)": round(f1, 4)
                    },
                    "status": "ok"
                })
            except Exception as e:
                results.append({"name": name, "description": description,
                                "type": "classification", "metrics": {},
                                "status": "error", "error": str(e)})
 
        df = df_full_loaded.copy()
 
        # ── 1. Dropout Risk Classifier (Random Forest) ──────────
        try:
            def classify_status(row):
                try:
                    g = float(str(row['Grade']).strip())
                    status = str(row['Status']).upper()
                    if g in [0.0, 9.0] or any(x in status for x in ['DROP', 'WITHDRAW', 'LOA']):
                        return 2
                    if g in [5.0, 8.0] or 'INC' in status:
                        return 1
                except:
                    pass
                return 0
 
            df['status_signal'] = df.apply(classify_status, axis=1)
            s_df = df.groupby("Student_ID").agg({
                "Gender": "first", "College": "first",
                "Semester": "first", "Year": "first",
                "Grade": ["mean", "min", "count"],
                "status_signal": "max"
            }).reset_index()
            s_df.columns = ["Student_ID", "Gender", "College", "Semester",
                            "Year", "Avg_Grade", "Min_Grade", "Subject_Count", "Status_Label"]
            s_df["Gender_Code"] = pd.to_numeric(s_df["Gender"], errors="coerce").fillna(0).astype(int)
            s_df["Year_Numeric"] = s_df["Year"].astype(str).str.extract(r"(\d{4})")[0]
            s_df["Year_Numeric"] = pd.to_numeric(s_df["Year_Numeric"], errors="coerce").fillna(2024)
            X1 = pd.get_dummies(s_df[["Gender_Code", "College", "Semester", "Year_Numeric",
                                      "Avg_Grade", "Min_Grade", "Subject_Count"]],
                                columns=["College", "Semester"], drop_first=False)
            y1 = s_df["Status_Label"]
            clf_metrics(drop_pie_model, drop_pie_features, X1, y1,
                        "Dropout Risk Classifier",
                        "Predicts student status: Regular / INC / Drop using Random Forest")
        except Exception as e:
            results.append({"name": "Dropout Risk Classifier", "type": "classification",
                            "description": "Random Forest — student status prediction",
                            "metrics": {}, "status": "error", "error": str(e)})
 
        # ── 2. Dropout Spike Model (Linear Regression) ──────────
        try:
            df2 = df.copy()
            df2['Year_Numeric'] = df2['Year'].astype(str).str.extract(r'^(\d{4})').astype(float)
            df2['Status'] = df2['Status'].astype(str).str.strip().str.upper()
            s2 = df2.groupby(['Student_ID', 'Year_Numeric', 'College'])['Status'].apply(list).reset_index()
            s2['is_dropout'] = s2['Status'].apply(
                lambda ss: 1 if any("DROP" in str(x) for x in ss) else 0)
            coh = s2.groupby(['Year_Numeric', 'College']).agg(
                total_students=('Student_ID', 'count'),
                dropout_count=('is_dropout', 'sum')).reset_index()
            coh['Dropout_Rate'] = (coh['dropout_count'] / coh['total_students']) * 100
            coh = coh[coh['total_students'] > 5]
            X2 = pd.get_dummies(coh[['College']], prefix='College')
            X2['Year_Numeric'] = coh['Year_Numeric'].values
            y2 = coh['Dropout_Rate'].values
            reg_metrics(dropout_spike_model, dropout_spike_features, X2, y2,
                        "Dropout Spike Forecast",
                        "Predicts dropout rate spikes by year & college using Linear Regression")
        except Exception as e:
            results.append({"name": "Dropout Spike Forecast", "type": "regression",
                            "description": "Linear Regression — dropout rate over time",
                            "metrics": {}, "status": "error", "error": str(e)})
 
        # ── 3. Dropout Ranking per College (Linear Regression) ──
        try:
            df3 = df.copy()
            df3["Year_Numeric"] = df3["Year"].astype(str).str.extract(r"(\d{4})")[0].astype(float)
            df3["Status"] = df3["Status"].astype(str).str.strip().str.upper()
            s3 = df3.groupby("Student_ID").agg({
                "College": "first", "Year_Numeric": "first",
                "Semester": "first", "Status": list}).reset_index()
            s3["is_drop"] = s3["Status"].apply(
                lambda ss: int(any("DROP" in str(x) for x in ss)))
            X3 = pd.get_dummies(s3[["College", "Semester"]], drop_first=False)
            X3["Year_Numeric"] = s3["Year_Numeric"].values
            y3 = s3["is_drop"].values
            reg_metrics(dropout_ranking_model, dropout_ranking_features, X3, y3,
                        "Dropout Ranking per College",
                        "Ranks colleges by predicted dropout likelihood using Linear Regression")
        except Exception as e:
            results.append({"name": "Dropout Ranking per College", "type": "regression",
                            "description": "Linear Regression — per-college dropout ranking",
                            "metrics": {}, "status": "error", "error": str(e)})
 
        # ── 4. GWA Ranking per College (Linear Regression) ──────
        try:
            df4 = df.copy()
            df4['Year_Numeric'] = df4['Year'].astype(str).str.extract(r'(\d{4})')[0].astype(float)
            sem_map4 = {'1': 1, '2': 2, 'SUMMER': 3}
            df4['Sem_Numeric'] = df4['Semester'].astype(str).str.upper().apply(
                lambda x: next((v for k, v in sem_map4.items() if k in x), 1))
            df4['GWA'] = pd.to_numeric(df4['GWA'], errors='coerce')
            df4 = df4.dropna(subset=['GWA', 'College', 'Year_Numeric'])
            df4 = df4[(df4['GWA'] >= 1.0) & (df4['GWA'] <= 5.0)]
            X4 = pd.get_dummies(df4[['College']], prefix='College', drop_first=False)
            X4['Year_Numeric'] = df4['Year_Numeric'].values
            X4['Sem_Numeric']  = df4['Sem_Numeric'].values
            y4 = df4['GWA'].values
            reg_metrics(gwa_ranking_model, gwa_ranking_features, X4, y4,
                        "GWA Ranking per College",
                        "Predicts average GWA per college using Linear Regression")
        except Exception as e:
            results.append({"name": "GWA Ranking per College", "type": "regression",
                            "description": "Linear Regression — GWA per college",
                            "metrics": {}, "status": "error", "error": str(e)})
 
        # ── 5. GWA Trend Model (Linear Regression) ──────────────
        try:
            df5 = df.copy()
            df5['GWA'] = pd.to_numeric(df5['GWA'], errors='coerce')
            df5 = df5[(df5['GWA'] >= 1.0) & (df5['GWA'] <= 5.0)]
            df5['Year_Numeric'] = df5['Year'].astype(str).str.extract(r'^(\d{4})').astype(int)
            sem_map5 = {"1sem": 1, "1st": 1, "2sem": 2, "2nd": 2, "summer": 3}
            df5['Sem_Numeric'] = df5['Semester'].astype(str).str.lower().apply(
                lambda x: next((v for k, v in sem_map5.items() if k in x), 1))
            X5 = pd.get_dummies(df5[['College']], drop_first=False, prefix='College')
            X5['Year_Numeric'] = df5['Year_Numeric'].values
            X5['Sem_Numeric']  = df5['Sem_Numeric'].values
            y5 = df5['GWA'].values
            reg_metrics(gwa_trend_model, gwa_trend_features, X5, y5,
                        "GWA Trend Forecast",
                        "Tracks GWA trends over semesters using Linear Regression")
        except Exception as e:
            results.append({"name": "GWA Trend Forecast", "type": "regression",
                            "description": "Linear Regression — semester GWA trend",
                            "metrics": {}, "status": "error", "error": str(e)})
 
        # ── 6. INC Rate Forecast (Random Forest Regressor) ──────
        try:
            df6 = df.copy()
            df6['Year_Numeric'] = df6['Year'].astype(str).str.extract(r'^(\d{4})').astype(int)
            df6['Status'] = df6['Status'].astype(str).str.strip().str.upper()
            s6 = df6.groupby(['Student_ID', 'Year_Numeric', 'College']).agg({
                'Status': lambda s: 1 if any("INC" in str(x) for x in s) else 0,
                'GWA': 'mean'}).reset_index()
            s6.rename(columns={'Status': 'has_inc'}, inplace=True)
            c6 = s6.groupby(['Year_Numeric', 'College']).agg(
                total_students=('Student_ID', 'count'),
                inc_student_count=('has_inc', 'sum'),
                avg_gwa=('GWA', 'mean')).reset_index()
            c6['INC_Rate'] = (c6['inc_student_count'] / c6['total_students']) * 100
            c6 = c6[c6['total_students'] > 5]
            X6_cats = pd.get_dummies(c6[['College']], prefix='College')
            X6 = pd.concat([X6_cats, c6[['Year_Numeric', 'avg_gwa']]], axis=1)
            y6 = c6['INC_Rate'].values
            reg_metrics(inc_model, inc_features, X6, y6,
                        "INC Rate Forecast",
                        "Forecasts incomplete-grade rates per college using Random Forest")
        except Exception as e:
            results.append({"name": "INC Rate Forecast", "type": "regression",
                            "description": "Random Forest Regressor — INC rate forecast",
                            "metrics": {}, "status": "error", "error": str(e)})
 
        # ── 7. Regular vs Irregular Rate (Linear Regression) ────
        try:
            df7 = df.copy()
            df7['Year_Numeric'] = df7['Year'].astype(str).str.extract(r'^(\d{4})').astype(int)
            df7['Status'] = df7['Status'].astype(str).str.strip().str.upper()
            sem_map7 = {"1sem": 1, "1st": 1, "2sem": 2, "2nd": 2, "summer": 3}
            df7['Sem_Numeric'] = df7['Semester'].astype(str).str.lower().apply(
                lambda x: next((v for k, v in sem_map7.items() if k in x), 1))
            s7 = df7.groupby(['Year_Numeric', 'College', 'Sem_Numeric', 'Student_ID']).agg(
                {'Status': list}).reset_index()
            s7['is_irregular'] = s7['Status'].apply(
                lambda ss: 1 if any(x in " ".join(str(v).upper() for v in ss)
                                    for x in ['DROP', 'INC']) else 0)
            c7 = s7.groupby(['Year_Numeric', 'College', 'Sem_Numeric']).agg(
                total_students=('Student_ID', 'count'),
                irregular_count=('is_irregular', 'sum')).reset_index()
            c7['Irregular_Rate'] = (c7['irregular_count'] / c7['total_students']) * 100
            c7 = c7[c7['total_students'] > 10]
            X7 = pd.get_dummies(c7[['College']], prefix='College')
            X7['Year_Numeric'] = c7['Year_Numeric'].values
            X7['Sem_Numeric']  = c7['Sem_Numeric'].values
            y7 = c7['Irregular_Rate'].values
            reg_metrics(status_model, status_features, X7, y7,
                        "Regular vs Irregular Rate",
                        "Forecasts irregular student rates per semester using Linear Regression")
        except Exception as e:
            results.append({"name": "Regular vs Irregular Rate", "type": "regression",
                            "description": "Linear Regression — irregularity rate forecast",
                            "metrics": {}, "status": "error", "error": str(e)})
 
        # ── 8. KPI GWA Forecaster (Linear Regression) ───────────
        try:
            df8 = df.copy()
            df8['Year_Numeric'] = df8['Year'].astype(str).str.extract(r'^(\d{4})').astype(float)
            sem_map8 = {"1sem": 1, "1st": 1, "2sem": 2, "2nd": 2, "summer": 3}
            df8['Sem_Numeric'] = df8['Semester'].astype(str).str.lower().apply(
                lambda x: next((v for k, v in sem_map8.items() if k in x), 1))
            df8['GWA'] = pd.to_numeric(df8['GWA'], errors='coerce')
            df8 = df8.dropna(subset=['GWA', 'Year_Numeric', 'College'])
            df8 = df8[(df8['GWA'] >= 1.0) & (df8['GWA'] <= 5.0)]
            X8 = pd.get_dummies(df8[['College']], prefix='College')
            X8['Year_Numeric'] = df8['Year_Numeric'].values
            X8['Sem_Numeric']  = df8['Sem_Numeric'].values
            y8 = df8['GWA'].values
            reg_metrics(kpi_gwa_model, kpi_gwa_features, X8, y8,
                        "KPI — GWA Forecaster",
                        "Powers the GWA KPI card using Linear Regression")
        except Exception as e:
            results.append({"name": "KPI — GWA Forecaster", "type": "regression",
                            "description": "Linear Regression — KPI GWA card",
                            "metrics": {}, "status": "error", "error": str(e)})
 
        # ── 9. KPI Enrollment Forecaster (Linear Regression) ────
        try:
            df9 = df.copy()
            df9['Year_Numeric'] = df9['Year'].astype(str).str.extract(r'^(\d{4})').astype(float)
            df9['GWA'] = pd.to_numeric(df9['GWA'], errors='coerce')
            df9 = df9.dropna(subset=['GWA', 'Year_Numeric', 'College'])
            df9 = df9[(df9['GWA'] >= 1.0) & (df9['GWA'] <= 5.0)]
            e9 = df9.groupby(['Year_Numeric', 'College'])['Student_ID'].nunique().reset_index()
            e9.rename(columns={'Student_ID': 'Count'}, inplace=True)
            X9 = pd.get_dummies(e9[['College']], prefix='College')
            X9['Year_Numeric'] = e9['Year_Numeric'].values
            y9 = e9['Count'].values
            reg_metrics(kpi_enroll_model, kpi_enroll_features, X9, y9,
                        "KPI — Enrollment Forecaster",
                        "Powers the Enrollment KPI card using Linear Regression")
        except Exception as e:
            results.append({"name": "KPI — Enrollment Forecaster", "type": "regression",
                            "description": "Linear Regression — KPI enrollment card",
                            "metrics": {}, "status": "error", "error": str(e)})
 
        # ── 10. Subject Risk Classifier (Random Forest) ─────────
        try:
            df10 = df.copy()
            df10['Year_Numeric'] = df10['Year'].astype(str).str.extract(r'^(\d{4})').astype(float)
            df10['Status'] = df10['Status'].astype(str).str.strip().str.upper()
            if 'Course_Subject_Name' in df10.columns:
                df10['Subject'] = df10['Course_Subject_Name'].str.upper().str.strip()
            elif 'Subject' in df10.columns:
                df10['Subject'] = df10['Subject'].str.upper().str.strip()
            else:
                raise ValueError("Subject column not found")
            df10['Grade'] = pd.to_numeric(df10['Grade'], errors='coerce')
            df10 = df10.dropna(subset=['Grade', 'Year_Numeric', 'College', 'Subject', 'Status'])
            def label_status(s):
                if "DROP" in s: return 2
                if "INC" in s:  return 1
                return 0
            df10['Status_Label'] = df10['Status'].apply(label_status)
            top_subjects = df10['Subject'].value_counts().nlargest(60).index.tolist()
            df10 = df10[df10['Subject'].isin(top_subjects)]
            X10 = pd.get_dummies(df10[['College', 'Subject']], prefix=['College', 'Subject'])
            X10['Year_Numeric'] = df10['Year_Numeric'].values
            X10['Grade']        = df10['Grade'].values
            y10 = df10['Status_Label'].values
            clf_metrics(subj_model, subj_features, X10, y10,
                        "Subject Risk Classifier",
                        "Classifies subject-level risk (Pass / INC / Drop) using Random Forest")
        except Exception as e:
            results.append({"name": "Subject Risk Classifier", "type": "classification",
                            "description": "Random Forest — per-subject risk classification",
                            "metrics": {}, "status": "error", "error": str(e)})
 
        return jsonify({"models": results, "total": len(results)})
 
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500