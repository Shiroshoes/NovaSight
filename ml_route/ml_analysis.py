import os
import joblib
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import io
import base64
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

        #  INPUTS ─
        year = int(request.args.get('year', 2024))
        college_arg = request.args.get('college', 'all').strip()
        semester = request.args.get('semester', 'all').strip()

        # normalize college filter
        if college_arg.lower() in ['main campus', 'overall', 'all', '']:
            target_college = 'all'
        else:
            target_college = college_arg

        #  MODE ─
        LATEST_REAL_YEAR = 2024
        is_forecast = year > LATEST_REAL_YEAR
        mode_label = "Forecast" if is_forecast else "Actual History"

        #  YEAR COLUMN FIX 
        if 'Year_Numeric' not in df_full_loaded.columns:
            df_full_loaded['Year_Numeric'] = (
                df_full_loaded['Year']
                .astype(str)
                .str.extract(r'^(\d{4})')[0]
                .astype(float)
            )

        #  SELECT COHORT ─
        if is_forecast:
            cohort = df_full_loaded[
                df_full_loaded['Year_Numeric'] == LATEST_REAL_YEAR
            ].copy()
        else:
            cohort = df_full_loaded[
                df_full_loaded['Year_Numeric'] == year
            ].copy()

        #  FILTERS 
        if target_college != 'all':
            cohort = cohort[
                cohort['College'].astype(str).str.strip().str.upper()
                == target_college.upper()
            ]

        if semester.lower() not in ['all', 'overall']:
            cohort = cohort[
                cohort['Semester'].astype(str).str.strip().str.upper()
                == semester.upper()
            ]

        if cohort.empty:
            return jsonify({
                "labels": [],
                "data": [],
                "total": 0,
                "mode": mode_label
            })

        student_cohort = cohort.groupby("Student_ID").agg({
            "Gender": "first",
            "College": "first",
            "Semester": "first",
            "Year": "first",
            "Grade": list
        }).reset_index()

        student_cohort["Grade"] = student_cohort["Grade"].apply(
            lambda x: x if isinstance(x, list) else []
        )

        #  STUDENT FLAGS ─

        student_cohort["is_drop"] = student_cohort["Grade"].apply(
            lambda grades: 0 in grades
        )

        student_cohort["is_inc"] = student_cohort["Grade"].apply(
            lambda grades: 5 in grades
        )

        student_cohort["Risk_Status"] = (
            student_cohort["is_drop"] | student_cohort["is_inc"]
        ).astype(int)

        actual_drops = int(student_cohort["is_drop"].sum())
        actual_incs = int(student_cohort["is_inc"].sum())


        forecast_risk = 0

        if is_forecast:

            # SAFE: student-level prediction base
            student_features = student_cohort.copy()

            X_pred = pd.DataFrame(
                0,
                index=np.arange(len(student_features)),
                columns=drop_pie_features
            )

            X_pred["Year_Numeric"] = year

            # Gender
            if "Gender" in drop_pie_features:
                if student_features["Gender"].dtype == "object":
                    X_pred["Gender"] = student_features["Gender"].map(
                        {"Male": 0, "Female": 1}
                    ).fillna(0).values
                else:
                    X_pred["Gender"] = student_features["Gender"].fillna(0).values

            # College encoding
            for col in drop_pie_features:
                if col.startswith("College_"):
                    c_name = col.replace("College_", "").strip()
                    mask = student_features["College"].astype(str).str.strip() == c_name
                    X_pred.loc[mask.values, col] = 1

                if col.startswith("Semester_"):
                    s_name = col.replace("Semester_", "").strip()
                    mask = student_features["Semester"].astype(str).str.strip() == s_name
                    X_pred.loc[mask.values, col] = 1

            # PREDICT (STUDENT LEVEL ONLY)
            preds = drop_pie_model.predict(X_pred)
            preds = np.clip(np.round(preds), 0, 1)

            student_features["Risk_Status"] = preds

            forecast_risk = int(np.sum(preds))

            # overwrite for pie chart consistency
            student_cohort = student_features

        # PIE CHART COMPUTATION (STUDENT LEVEL ONLY)

        df_final = student_cohort.copy()

        if df_final["Gender"].dtype == "object":
            df_final["Gender_Num"] = df_final["Gender"].map(
                {"Male": 0, "Female": 1}
            ).fillna(0)
        else:
            df_final["Gender_Num"] = df_final["Gender"].fillna(0)

        m_stay = len(df_final[(df_final["Risk_Status"] == 0) & (df_final["Gender_Num"] == 0)])
        f_stay = len(df_final[(df_final["Risk_Status"] == 0) & (df_final["Gender_Num"] == 1)])
        m_risk = len(df_final[(df_final["Risk_Status"] == 1) & (df_final["Gender_Num"] == 0)])
        f_risk = len(df_final[(df_final["Risk_Status"] == 1) & (df_final["Gender_Num"] == 1)])

        total = len(df_final)

        risk_pct = round(((m_risk + f_risk) / total * 100), 1) if total > 0 else 0

        #  RESPONSE 

        return jsonify({
            "labels": ["Male (Safe)", "Female (Safe)", "Male (Risk)", "Female (Risk)"],
            "data": [m_stay, f_stay, m_risk, f_risk],
            "colors": ["#4e73df", "#36b9cc", "#e74a3b", "#f6c23e"],
            "total": total,
            "risk_pct": risk_pct,
            "mode": mode_label,
            "breakdown": {
                "actual_drops": actual_drops,
                "actual_incs": actual_incs,
                "forecast_risk": forecast_risk
            }
        })

    except Exception as e:
        print(f"Dropout Pie Error: {e}")
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