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

#  1. GLOBAL DATA LOADING & CLEANING (Run once at startup) 
# This fixes the "No Data" issue by creating the Year_Numeric column right here.
DATA_PATH = "processed_datasets/Final_Merged_Student_Data.csv"
MODEL_DIR = "Machine_Learning_Model"

print(" Loading ML Data & Models ")

# Load Data
if os.path.exists(DATA_PATH):
    try:
        df_full_loaded = pd.read_csv(DATA_PATH)
        
        # Filter out invalid grades
        df_full_loaded = df_full_loaded[df_full_loaded['GWA'] > 0].copy()
        
        # FIX: Extract Year_Numeric for the API (e.g., '2022-2023' -> 2022)
        # We use raw string r'' to avoid the syntax warning
        df_full_loaded['Year_Numeric'] = df_full_loaded['Year'].astype(str).str.extract(r'^(\d{4})').astype(float)
        
        # FIX: Map Semesters for X-axis (1 vs 2)
        sem_map = {
            "1sem": 1, "1st sem": 1, "first": 1,
            "2sem": 2, "2nd sem": 2, "second": 2,
            "summer": 3
        }
        df_full_loaded['Sem_Numeric'] = df_full_loaded['Semester'].astype(str).str.lower().map(sem_map).fillna(1)
        
        # Clean up NaNs
        df_full_loaded = df_full_loaded.dropna(subset=['Year_Numeric', 'Sem_Numeric', 'GWA'])
        print(f"Data Loaded: {len(df_full_loaded)} rows.")
        
    except Exception as e:
        print(f"Data Load Error: {e}")
        df_full_loaded = pd.DataFrame()
else:
    print("Error: CSV file not found.")
    df_full_loaded = pd.DataFrame()

# Load Models (Safe Loading)
def load_model(filename):
    path = os.path.join(MODEL_DIR, filename)
    return joblib.load(path) if os.path.exists(path) else None

gender_model = load_model("gender_dropout_model_with_year.pkl")
model_features = load_model("model_features_with_year.pkl")

gwa_rank_model = load_model("gwa_ranking_model_final.pkl")
gwa_feat = load_model("gwa_ranking_features_final.pkl")

drop_rank_model = load_model("college_dropout_model_final.pkl")
drop_feat = load_model("dropout_ranking_features_final.pkl")

trend_model = load_model("gwa_trend_model_final.pkl")
trend_feat = load_model("gwa_trend_features.pkl")


#  ROUTE 1: ML BOXPLOT (Gender Analysis) 
@ml_bp.route('/api/get_boxplot_chart/<college_name>')
def get_boxplot_chart(college_name):
    try:
        year = int(request.args.get('year', 2030)) # Defaults to 2030 if null
        
        if not gender_model or not model_features:
            return jsonify({"error": "Model not loaded"}), 500

        def get_pred(is_male, college, target_year):
            X = pd.DataFrame(np.zeros((1, len(model_features))), columns=model_features)
            if 'Gender' in model_features: X['Gender'] = 0 if is_male else 1
            
            col_key = f"College_{college}"
            if college != 'all' and col_key in model_features: X[col_key] = 1
            
            if 'Year_Numeric' in model_features: X['Year_Numeric'] = target_year
            return float(gender_model.predict(X)[0])

        male_base = get_pred(True, college_name, year) * 100
        female_base = get_pred(False, college_name, year) * 100
        
        np.random.seed(42)
        male_dist = np.random.normal(male_base, 2.5, 100)
        female_dist = np.random.normal(female_base, 2.5, 100)

        plt.figure(figsize=(6, 4))
        bp = plt.boxplot([male_dist, female_dist], tick_labels=['Male', 'Female'], patch_artist=True)
        colors = ['#3498db', '#e74c3c']
        for patch, c in zip(bp['boxes'], colors):
            patch.set_facecolor(c)
            patch.set_alpha(0.6)

        plt.ylabel('Predicted Dropout Risk (%)')
        title_prefix = "Overall" if college_name == 'all' else college_name
        plt.title(f"{title_prefix} Risk Analysis ({year})")
        plt.grid(axis='y', linestyle='--', alpha=0.3)

        buf = io.BytesIO()
        plt.savefig(buf, format='png', bbox_inches='tight')
        buf.seek(0)
        plot_url = base64.b64encode(buf.getvalue()).decode('utf-8')
        plt.close()

        return jsonify({"chart_url": f"data:image/png;base64,{plot_url}", "prediction_year": year})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


#  ROUTE 2: GWA RANKING (Bar Chart) 
@ml_bp.route('/api/get_gwa_ranking_data/<int:selected_year>')
def get_gwa_ranking_data(selected_year):
    try:
        sel_sem = request.args.get('semester', 'all')
        sel_college = request.args.get('college', 'all')

        results = []
        college_cols = [f for f in gwa_feat if f.startswith('College_')]

        if sel_college != 'all':
            target = f"College_{sel_college}"
            college_cols = [target] if target in college_cols else []

        for col_feat in college_cols:
            X = pd.DataFrame(np.zeros((1, len(gwa_feat))), columns=gwa_feat)
            X[col_feat] = 1
            if 'Year_Numeric' in gwa_feat: X['Year_Numeric'] = selected_year
            
            sem_col = f"Semester_{sel_sem}"
            if sel_sem != 'all' and sem_col in gwa_feat: X[sem_col] = 1
            
            pred = float(gwa_rank_model.predict(X)[0])
            results.append({"college": col_feat.replace('College_', ''), "gwa": round(pred, 2)})

        return jsonify(sorted(results, key=lambda x: x['gwa'], reverse=True))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


#  ROUTE 3: DROPOUT RANKING (Bar Chart) 
@ml_bp.route('/api/get_dropout_ranking_data/<int:selected_year>')
def get_dropout_ranking_data(selected_year):
    try:
        sel_sem = request.args.get('semester', 'all')
        
        results = []
        college_cols = [f for f in drop_feat if f.startswith('College_')]

        for col_feat in college_cols:
            X = pd.DataFrame(np.zeros((1, len(drop_feat))), columns=drop_feat)
            X[col_feat] = 1
            if 'Year_Numeric' in drop_feat: X['Year_Numeric'] = selected_year
            
            sem_col = f"Semester_{sel_sem}"
            if sel_sem != 'all' and sem_col in drop_feat: X[sem_col] = 1
            
            risk_pct = float(drop_rank_model.predict(X)[0]) * 100
            results.append({"college": col_feat.replace('College_', ''), "risk": round(max(0, risk_pct), 2)})

        return jsonify(sorted(results, key=lambda x: x['risk'], reverse=True))
    except Exception as e:
        return jsonify({"error": str(e)}), 500



#  ROUTE 4: GWA TREND (Scatter Plot) 
@ml_bp.route('/api/get_gwa_trend_data/<int:selected_year>')
def get_gwa_trend_data(selected_year):
    try:
        sel_college = request.args.get('college', 'all')
        sel_sem = request.args.get('semester', 'all') # Grab semester filter
        
        # GET SCATTER POINTS (Only if year is in past/present)
        real_points = []
        is_future = selected_year > 2025 

        if not is_future and not df_full_loaded.empty:
            # Filter global data by year
            mask = (df_full_loaded['Year_Numeric'] == selected_year)
            
            # Filter by College
            if sel_college != 'all':
                mask = mask & (df_full_loaded['College'] == sel_college)

            # Filter by Semester (NEW)
            if sel_sem != 'all':
                # Simple mapping based on your dropdown values ('1sem', '2sem')
                sem_val = 1 if '1' in sel_sem else 2
                mask = mask & (df_full_loaded['Sem_Numeric'] == sem_val)
            
            df_target = df_full_loaded[mask]
            
            if not df_target.empty:
                # Sample 100 points to keep it fast
                df_sample = df_target.sample(n=min(100, len(df_target)))
                real_points = df_sample[['Sem_Numeric', 'GWA']].rename(columns={'Sem_Numeric': 'x', 'GWA': 'y'}).to_dict('records')

        # GET TREND LINE (Always show full year context)
        # Even if filtered to "1st Sem", we show the line from Sem 1 to Sem 2 
        # so the user can see the trajectory/slope.
        trend_line = []
        for sem in [1, 2]: 
            X = pd.DataFrame(np.zeros((1, len(trend_feat))), columns=trend_feat)
            
            if 'Year_Numeric' in trend_feat: X['Year_Numeric'] = selected_year
            if 'Sem_Numeric' in trend_feat: X['Sem_Numeric'] = sem
            
            if sel_college != 'all':
                col_key = f"College_{sel_college}"
                if col_key in trend_feat: X[col_key] = 1
                
            pred = float(trend_model.predict(X)[0])
            trend_line.append({"x": sem, "y": round(pred, 2)})

        return jsonify({
            "points": real_points,
            "trend_line": trend_line,
            "year": selected_year,
            "is_future": is_future
        })
    except Exception as e:
        print(f"Trend Error: {e}")
        return jsonify({"error": str(e)}), 500
    




# LOAD KPI MODELS
# Ensure these .pkl files exist in your Machine_Learning_Model folder
kpi_gwa_model = load_model("kpi_gwa_model.pkl")
kpi_gwa_features = load_model("kpi_gwa_features.pkl")

kpi_enroll_model = load_model("kpi_enrollment_model.pkl")
kpi_enroll_features = load_model("kpi_enrollment_features.pkl")

# ROUTE: KPI METRICS (Actual vs Predicted)
@ml_bp.route('/api/get_kpi_metrics')
def get_kpi_metrics():
    try:
        # 1. Parse Inputs
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
status_model = load_model("status_forest_model.pkl")
status_features = load_model("status_forest_features.pkl")

@ml_bp.route('/api/get_status_distribution')
def get_status_distribution():
    try:
        # 1. Inputs
        year = int(request.args.get('year', 2024))
        semester = request.args.get('semester', 'all')
        college = request.args.get('college', 'all')

        print(f"\n--- DEBUG: STATUS DISTRIBUTION ({college}) ---")

        # 2. Data Safety & Virtual Cohort
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

        # 3. Build Prediction Features
        X_pred = pd.DataFrame(0, index=np.arange(len(base_df)), columns=status_features)
        X_pred['Year_Numeric'] = year
        X_pred['Sem_Numeric'] = 1 if '1' in semester else 2

        # 4. ROBUST MAPPING (The Fix)
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

        # 5. Predict
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
# ... [Imports] ...
# LOAD INC MODEL
inc_model = load_model("inc_rate_model.pkl")
inc_features = load_model("inc_rate_features.pkl")

@ml_bp.route('/api/get_inc_forecast')
def get_inc_forecast():
    try:
        college = request.args.get('college', 'all')
        
        # PREPARE DATA
        # Ensure numeric year exists
        if 'Year_Numeric' not in df_full_loaded.columns:
            df_full_loaded['Year_Numeric'] = df_full_loaded['Year'].astype(str).str.extract(r'^(\d{4})').astype(int)
            
        # Define Column for INC Logic (Same as training)
        if 'is_inc' not in df_full_loaded.columns:
            if 'Remarks' in df_full_loaded.columns:
                df_full_loaded['is_inc'] = df_full_loaded['Remarks'].apply(lambda x: 1 if str(x).upper().strip() == 'INC' else 0)
            else:
                df_full_loaded['is_inc'] = 0 # Fallback

        # GET HISTORICAL DATA (2022-2024)
        history_years = sorted(df_full_loaded['Year_Numeric'].unique())
        historical_rates = []
        
        for yr in history_years:
            df_year = df_full_loaded[df_full_loaded['Year_Numeric'] == yr]
            if college != 'all':
                # Robust filtering
                df_year = df_year[df_year['College'].str.strip().str.upper() == college.strip().upper()]
            
            total = df_year['Student_ID'].nunique()
            inc_count = df_year['is_inc'].sum()
            rate = (inc_count / total * 100) if total > 0 else 0
            historical_rates.append(round(rate, 2))

        # GENERATE PREDICTIONS (2025-2030)
        future_years = [2025, 2026, 2027, 2028, 2029, 2030]
        predicted_rates = []

        # Prepare Feature Vector Structure
        # If college is 'all', we must predict for ALL colleges and average them
        colleges_to_predict = []
        if college != 'all':
            colleges_to_predict = [college]
        else:
            # Get all known colleges from features
            colleges_to_predict = [c.replace('College_', '') for c in inc_features if c.startswith('College_')]

        for yr in future_years:
            rates_sum = 0
            count = 0
            
            for col_name in colleges_to_predict:
                # Build Input
                X_pred = pd.DataFrame(np.zeros((1, len(inc_features))), columns=inc_features)
                X_pred['Year_Numeric'] = yr
                
                feat_col = f"College_{col_name}"
                if feat_col in inc_features:
                    X_pred[feat_col] = 1
                
                # Predict
                pred = inc_model.predict(X_pred)[0]
                rates_sum += max(0, pred) # No negative rates
                count += 1
            
            # Average the predictions
            avg_pred = rates_sum / count if count > 0 else 0
            predicted_rates.append(round(avg_pred, 2))

        # ERGE FOR CHART
        # We return two datasets: History (solid line) and Forecast (dashed line)
        # To connect lines visually, the Forecast should start at the last Historical point
        
        return jsonify({
            "years_hist": [int(y) for y in history_years],
            "data_hist": historical_rates,
            "years_pred": future_years,
            "data_pred": predicted_rates,
            "college": college
        })

    except Exception as e:
        print(f"INC Forecast Error: {e}")
        return jsonify({"error": str(e)}), 500





#subject top
subject_model = load_model("subject_grade_model.pkl")
subject_features = load_model("subject_grade_features.pkl")

@ml_bp.route('/api/get_subject_forecast')
def get_subject_forecast():
    try:
        college = request.args.get('college', 'all')
        print(f"\n--- DEBUG: SUBJECT FORECAST ({college}) ---")
        
        local_df = df_full_loaded.copy()

        # 1. DETECT CORRECT COLUMN
        subject_col = 'Course_Subject_Name' 
        if subject_col not in local_df.columns:
            if 'Subject' in local_df.columns:
                subject_col = 'Subject'
            else:
                return jsonify({"error": "Missing Subject Column"}), 400

        # 2. FILTER BY COLLEGE
        # Use case-insensitive matching for filtering the DataFrame
        if college != 'all':
            local_df = local_df[local_df['College'].str.strip().str.upper() == college.strip().upper()]

        # 3. GET TOP 10 SUBJECTS
        top_10 = local_df[subject_col].value_counts().nlargest(10).index.tolist()
        
        if not top_10:
            return jsonify({"datasets": [], "labels": []})

        # 4. PREPARE MODEL MAPPING (The Fix)
        # Find the exact feature name for the College (e.g. 'CAHS' -> 'College_College of Allied...')
        model_college_col = None
        if college != 'all':
            for feat in subject_features:
                if feat.startswith("College_"):
                    # Check if the requested college matches the feature name (ignoring case/space)
                    feat_name = feat.replace("College_", "").upper().strip()
                    if feat_name == college.upper().strip():
                        model_college_col = feat
                        break
            if not model_college_col:
                print(f" > Warning: Model has no feature for college '{college}'. Predictions may be lower.")
        
        # Get all known subjects in the model for faster lookup
        model_subjects = {feat.replace("Subject_", "").upper().strip(): feat for feat in subject_features if feat.startswith("Subject_")}

        # 5. GENERATE DATA
        years_hist = [2022, 2023, 2024]
        years_pred = [2026, 2028, 2030]
        all_years = sorted(years_hist + years_pred)
        datasets = []
        colors = ["#4e73df", "#1cc88a", "#36b9cc", "#f6c23e", "#e74a3b", "#858796", "#5a5c69", "#fd7e14", "#6610f2", "#20c997"]

        for i, subj in enumerate(top_10):
            data_points = []
            last_valid_score = 0
            
            clean_subj_name = str(subj).strip().upper()

            for yr in all_years:
                if yr <= 2024:
                    # HISTORICAL
                    mask = (local_df[subject_col] == subj) & (local_df['Year_Numeric'] == yr)
                    val = local_df.loc[mask, 'GWA'].mean()
                    
                    if not pd.isna(val):
                        score = round(val, 2)
                        data_points.append(score)
                        last_valid_score = score
                    else:
                        data_points.append(None)
                else:
                    # PREDICTION
                    X_in = pd.DataFrame(0, index=[0], columns=subject_features)
                    X_in['Year_Numeric'] = yr
                    
                    # A. Set Correct College Feature
                    if model_college_col:
                        X_in[model_college_col] = 1
                    
                    # B. Set Correct Subject Feature
                    # Look up the exact feature name from our map
                    if clean_subj_name in model_subjects:
                        target_feat = model_subjects[clean_subj_name]
                        X_in[target_feat] = 1
                        
                        try:
                            pred = float(subject_model.predict(X_in)[0])
                            
                            # SANITY CHECK: Prevent massive drops
                            # If prediction drops > 10% below last known, clamp it
                            if last_valid_score > 0 and pred < (last_valid_score * 0.9):
                                # print(f" > Clamping drop for {subj}: {pred} -> {last_valid_score}")
                                pred = last_valid_score * 0.98 # Slow decay instead of crash
                            
                            data_points.append(round(pred, 2))
                        except:
                            data_points.append(last_valid_score) # Fallback
                    else:
                        # Model doesn't know this subject -> Flatline the last known value
                        data_points.append(last_valid_score)

            datasets.append({
                "label": str(subj),
                "data": data_points,
                "borderColor": colors[i % len(colors)],
                "fill": False,
                "tension": 0.3
            })

        return jsonify({"labels": all_years, "datasets": datasets})

    except Exception as e:
        print(f"Subject Error: {e}")
        return jsonify({"error": str(e)}), 500




#drop spike
dropout_model = load_model("dropout_spike_model.pkl")
dropout_features = load_model("dropout_spike_features.pkl")

@ml_bp.route('/api/get_dropout_spike')
def get_dropout_spike():
    try:
        college = request.args.get('college', 'all')
        print(f"\n--- DEBUG: DROPOUT SPIKE ({college}) ---")

        # 1. LOAD DATA
        local_df = df_full_loaded.copy()
        
        # 2. FIND THE STATUS COLUMN
        # We look for these common names. Add yours if it's different (e.g., 'Student_Status')
        possible_cols = ['Status', 'Remarks', 'Student_Status', 'status']
        status_col = None
        
        for col in possible_cols:
            if col in local_df.columns:
                status_col = col
                break
        
        if status_col:
            print(f" > Found Status Column: '{status_col}'")
            # Logic: Mark 1 if row contains "DROP", "FAIL", or "UD"
            local_df['is_dropped'] = local_df[status_col].astype(str).str.upper().apply(
                lambda x: 1 if any(s in x for s in ['DROP', 'FAIL', 'UD', 'INACTIVE']) else 0
            )
        else:
            print(f" > CRITICAL: No Status column found in {local_df.columns.tolist()}")
            return jsonify({"error": "Missing Status/Remarks column in CSV"}), 400

        # 3. FILTER BY COLLEGE
        if college != 'all':
            # Case-insensitive match
            local_df = local_df[local_df['College'].str.strip().str.upper() == college.strip().upper()]

        # 4. CALCULATE HISTORY (2022-2024)
        if 'Year_Numeric' not in local_df.columns:
             local_df['Year_Numeric'] = local_df['Year'].astype(str).str.extract(r'^(\d{4})').astype(int)

        years_hist = sorted(local_df['Year_Numeric'].unique())
        data_points = []
        
        print(f" > Analyzing Years: {years_hist}")

        for yr in years_hist:
            yr_df = local_df[local_df['Year_Numeric'] == yr]
            total = yr_df['Student_ID'].nunique()
            dropped = yr_df['is_dropped'].sum()
            
            rate = (dropped / total * 100) if total > 0 else 0
            data_points.append(round(rate, 2))
            
        print(f" > Historical Rates: {data_points}")

        # 5. PREDICT FUTURE (2026-2030)
        years_pred = [2026, 2027, 2028, 2029, 2030]
        
        # Match College Feature for Model
        model_college_feat = None
        if college != 'all':
            for feat in dropout_features:
                if feat.startswith("College_") and college.upper() in feat.upper():
                    model_college_feat = feat
                    break

        for yr in years_pred:
            # Build Input Vector
            X_in = pd.DataFrame(0, index=[0], columns=dropout_features)
            X_in['Year_Numeric'] = yr
            if model_college_feat:
                X_in[model_college_feat] = 1
            
            # Predict
            try:
                pred = float(dropout_model.predict(X_in)[0])
                data_points.append(round(max(0, pred), 2))
            except Exception as e:
                print(f" > Prediction Error for {yr}: {e}")
                data_points.append(0)

        all_years = [int(y) for y in list(years_hist) + years_pred]

        # 6. DETECT SPIKES
        spikes = []
        for i in range(len(data_points)):
            if i == 0:
                spikes.append(False)
            else:
                prev = data_points[i-1]
                curr = data_points[i]
                # Spike = Increase of > 10% (relative) AND value > 0
                if prev > 0 and ((curr - prev) / prev) > 0.10:
                    spikes.append(True)
                else:
                    spikes.append(False)

        return jsonify({
            "labels": all_years,
            "data": data_points,
            "spikes": spikes
        })

    except Exception as e:
        print(f" Dropout Route Error: {e}")
        return jsonify({"error": str(e)}), 500