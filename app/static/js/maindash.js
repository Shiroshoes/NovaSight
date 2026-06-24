let gwaRankingChart;
let gwaScatterChart;
let statusPieChart;
let incForecastChart;
let dropoutPieChart; 
let dropoutRankingChart;

//  1. CENTRAL FILTER LOGIC 
document.addEventListener("DOMContentLoaded", function() {
    const yearSelector = document.getElementById('globalYearFilter'); // or 'selectYear'
    const semSelector = document.getElementById('filterSemester');
    const collegeSelector = document.getElementById('filterCollege'); // or 'selectCollege'

    function triggerUpdate() {
        const year = yearSelector ? yearSelector.value : 2024;
        const semester = semSelector ? semSelector.value : 'all';
        
        //  FIX: HANDLE 'Main' LOGIC 
        let collegeRaw = collegeSelector ? collegeSelector.value : 'all';
        // If the value is "Main campus" or empty, send 'all' to Python
        let college = (collegeRaw === 'Main Campus' || collegeRaw === '') ? 'all' : collegeRaw;

        console.log(`Updating all charts for: ${year}, ${semester}, ${college}`);

        // Update Bar Charts
        if (typeof updateGWARanking === 'function') updateGWARanking(year, semester, college);
        if (typeof updateDropoutRanking === 'function') updateDropoutRanking(year, semester, college);
        
        // Update ML Charts
        if (typeof updateGwaTrend === 'function') updateGwaTrend(year, semester, college); 
        if (typeof updateStatusChart === 'function') updateStatusChart(year, semester, college);
        if (typeof updateKPIMetrics === 'function') updateKPIMetrics(year, semester, college);
        if (typeof updateIncForecast === 'function') updateIncForecast(college);
        if (typeof updateDropoutPie === 'function') updateDropoutPie(year, college);
        if (typeof updateGwaScatter === 'function') updateGwaScatter(year, college, semester);
    }

    // Initial load
    triggerUpdate();

    // Listen for changes
    if (yearSelector) yearSelector.addEventListener('change', triggerUpdate);
    if (semSelector) semSelector.addEventListener('change', triggerUpdate);
    if (collegeSelector) collegeSelector.addEventListener('change', triggerUpdate);
});



// M/F piechart GWA
function updateDropoutPie(year, college) {
    // Get Semester from the dropdown
    const semDropdown = document.getElementById('filterSemester');
    const semester = semDropdown ? semDropdown.value : 'all';

    const canvas = document.getElementById('dropoutPieChart');
    if (!canvas) return;

    fetch(`/api/get_dropout_pie?year=${year}&college=${college}&semester=${semester}`)
        .then(res => res.json())
        .then(data => {
            // 1. Handle Empty Data
            if (data.error || !data.data || data.total === 0) {
                if(document.getElementById('dp-total')) document.getElementById('dp-total').innerText = "0";
                if(document.getElementById('val-drop')) document.getElementById('val-drop').innerText = "0";
                
                // Optional: Clear chart if no data
                if (dropoutPieChart) {
                    dropoutPieChart.data.datasets[0].data = [];
                    dropoutPieChart.update();
                }
                return;
            }
            
            // 2. Update Badges & Text (DOM Manipulation)
            const badge = document.getElementById('drop-pie-badge');
            if(badge) {
                badge.innerText = `${year} ${data.mode}`;
                if (data.mode === "Forecast") {
                    badge.className = "badge bg-warning text-dark";
                    badge.style.backgroundColor = "#ffc107"; 
                } else {
                    badge.className = "badge bg-success text-white";
                    badge.style.backgroundColor = "#1cc88a";
                }
            }

            const titleSpan = document.getElementById('dp-college-name');
            if(titleSpan) {
                let displayCollege = (college === 'all' || college === 'Overall') ? 'Main Campus' : college;
                let displaySem = (semester === 'all') ? '' : `(${semester})`;
                titleSpan.innerText = `${displayCollege} ${displaySem}`;
            }

            const b = data.breakdown;
            if(document.getElementById('val-pred')) document.getElementById('val-pred').innerText = b.forecast_risk || 0;
            if(document.getElementById('val-drop')) document.getElementById('val-drop').innerText = b.actual_drops || 0;
            if(document.getElementById('val-inc')) document.getElementById('val-inc').innerText = b.actual_incs || 0;


            // --- 3. RENDER CHART WITH ANIMATION ---
            const ctx = canvas.getContext('2d');

            if (dropoutPieChart) {
                // === MORPHING LOGIC ===
                // Instead of destroying, we simply update the data arrays.
                // Chart.js will automatically interpolate the transition.
                
                dropoutPieChart.data.labels = data.labels;
                dropoutPieChart.data.datasets[0].data = data.data;
                dropoutPieChart.data.datasets[0].backgroundColor = data.colors;
                
                dropoutPieChart.update(); // <--- Triggers the smooth animation
                
            } else {
                // === INITIAL CREATION ===
                dropoutPieChart = new Chart(ctx, {
                    type: 'doughnut',
                    data: {
                        labels: data.labels,
                        datasets: [{
                            data: data.data,
                            backgroundColor: data.colors,
                            hoverBorderColor: "rgba(255, 255, 255, 1)",
                            borderWidth: 2,
                            hoverOffset: 10 // Pops out on hover
                        }],
                    },
                    options: {
                        maintainAspectRatio: false,
                        cutout: '70%', // Thinner ring looks more modern
                        responsive: true,
                        animation: {
                            animateScale: true,  // Zooms in from center
                            animateRotate: true, // Spins in
                            duration: 800,
                            easing: 'easeOutQuart'
                        },
                        plugins: {
                            legend: { display: false },
                            tooltip: {
                                backgroundColor: "rgba(255,255,255,0.9)",
                                bodyColor: "#858796",
                                borderColor: '#dddfeb',
                                borderWidth: 1,
                                callbacks: {
                                    label: function(context) {
                                        let value = context.raw;
                                        let label = context.label;
                                        let pct = Math.round((value / data.total) * 100) + '%';
                                        return ` ${label}: ${value} (${pct})`;
                                    }
                                }
                            }
                        }
                    }
                });
            }
        })
        .catch(err => console.error("Dropout Pie Fatal Error:", err));
}





//  GWA RANKING CHART (Bar)
function updateGWARanking(year, semester, college) {
    const canvas = document.getElementById('gwaRankingChart');
    if (!canvas) return;

    const collegeColors = {
        'CCST': 'rgba(138, 43, 226, 0.8)',
        'CEA':  'rgba(28, 200, 138, 0.8)',
        'CBA':  'rgba(231, 74, 59, 0.8)',
        'CAHS': 'rgba(54, 185, 204, 0.8)',
        'CTEC': 'rgba(78, 115, 223, 0.8)',
        'COAS': 'rgba(90, 92, 105, 0.8)'
    };

    fetch(`/api/get_gwa_ranking_data/${year}?semester=${semester}&college=${college}`)
        .then(res => res.json())
        .then(data => {
            if (data.error) return console.error("GWA Ranking Error:", data.error);

            //  1. FILTER DATA 
            let displayData = data;
            if (college && college !== 'all' && college !== 'Main Campus') {
                displayData = data.filter(d => d.college.toUpperCase() === college.toUpperCase());
            }

            const labels = displayData.map(item => item.college);
            const values = displayData.map(item => item.gwa);
            
            //  2. COLORS 
            const backgroundColors = labels.map(c => {
                return collegeColors[c.toUpperCase()] || '#4e73df'; 
            });

            const semText = semester === 'all' ? 'Overall' : semester;
            const collText = (college === 'all' || !college) ? 'Main Campus' : college;
            const newTitle = `Academic Performance: ${year} (${semText} - ${collText})`;

            const ctx = canvas.getContext('2d');

            //  3. ANIMATION LOGIC (Update vs Create) 
            if (gwaRankingChart) {
                // IF CHART EXISTS: Update data and animate the transition
                gwaRankingChart.data.labels = labels;
                gwaRankingChart.data.datasets[0].data = values;
                gwaRankingChart.data.datasets[0].backgroundColor = backgroundColors;
                
                // Update Title
                if (gwaRankingChart.options.plugins.title) {
                    gwaRankingChart.options.plugins.title.text = newTitle;
                }
                
                gwaRankingChart.update(); // < THIS TRIGGERS THE ANIMATION
            } else {
                // IF CHART IS NEW: Create it from scratch
                gwaRankingChart = new Chart(ctx, {
                    type: 'bar',
                    data: {
                        labels: labels,
                        datasets: [{
                            label: 'Average GWA (Lower is Better)',
                            data: values,
                            backgroundColor: backgroundColors,
                            borderColor: '#000000',
                            borderWidth: 1,
                            borderRadius: 4,
                            
                            // Layout Controls
                            barPercentage: 0.8,
                            categoryPercentage: 0.8,
                            maxBarThickness: 500 
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        animation: {
                            duration: 500,
                            easing: 'easeOutQuart'
                        },
                        layout: {
                            padding: { left: 10, right: 10, top: 25, bottom: 0 }
                        },
                        plugins: {
                            legend: { display: false },
                            title: { 
                                display: true, 
                                text: newTitle,
                                font: { size: 14 }
                            },
                            tooltip: {
                                callbacks: {
                                    label: function(context) {
                                        return ` GWA: ${context.raw.toFixed(2)}`;
                                    }
                                }
                            }
                        },
                        scales: {
                            y: {
                                min: 1.0,
                                max: 3.5,
                                title: { display: true, text: 'GWA Scale (1.0 = Highest)' },
                                ticks: { stepSize: 0.25 }
                            },
                            x: {
                                grid: { display: false }
                            }
                        }
                    }
                });
            }
        })
        .catch(err => console.error("GWA Ranking Fatal:", err));
}




// DROPOUT RANKING CHART (Bar)
function updateDropoutRanking(year, semester, college = 'all') {
    const canvas = document.getElementById('dropoutRankingChart');
    const subtitle = document.getElementById('dropoutRankSubtitle');
    
    if (!canvas) return;

    // 1. Sanitize Inputs
    let safeCollege = String(college || 'all').trim();
    if (safeCollege.toLowerCase() === 'main campus' || safeCollege === '') {
        safeCollege = 'all';
    }
    const apiSemester = semester || 'all';

    // 2. Update Subtitle
    if (subtitle) {
        let colText = (safeCollege === 'all') ? 'Main Campus' : safeCollege;
        subtitle.textContent = `( ${year} | ${apiSemester} | ${colText} )`;
    }

    // 3. Fetch Data
    fetch(`/api/get_dropout_ranking?year=${year}&semester=${apiSemester}`)
        .then(res => res.json())
        .then(data => {
            if (data.error) return console.error("Ranking API Error:", data.error);

            const chartData = data.data || [];

            // 4. Handle Empty Data (Prevents Crash)
            if (chartData.length === 0) {
                if (dropoutRankingChart) {
                    dropoutRankingChart.data.labels = [];
                    dropoutRankingChart.data.datasets[0].data = [];
                    dropoutRankingChart.update();
                }
                return;
            }

            const labels = chartData.map(d => d.college);
            const values = chartData.map(d => d.rate);

            // 5. Highlight Logic
            const backgroundColors = chartData.map(d => {
                if (safeCollege !== 'all') {
                    return (d.college === safeCollege.toUpperCase()) ? "#e74a3b" : "#eaecf4";
                }
                return "#e74a3b"; 
            });

            const borderColors = backgroundColors.map(c => c === "#eaecf4" ? "#d1d3e2" : "#c0392b");

            const ctx = canvas.getContext('2d');

            if (dropoutRankingChart) {
                dropoutRankingChart.destroy();
            }

            // 6. Calculate Axis Scale (Prevents -Infinity Crash)
            const maxVal = values.length > 0 ? Math.max(...values) : 0;
            // Add 20% padding so the longest bar doesn't hit the edge
            const xMax = maxVal === 0 ? 5 : maxVal + (maxVal * 0.2); 

            dropoutRankingChart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Dropout Rate (%)',
                        data: values,
                        backgroundColor: backgroundColors,
                        borderColor: borderColors,
                        borderWidth: 1,
                        barPercentage: 0.7,
                    }]
                },
                options: {
                    indexAxis: 'y', // Horizontal
                    maintainAspectRatio: false,
                    responsive: true,
                    layout: { padding: { left: 10, right: 30, top: 20, bottom: 0 } },
                    scales: {
                        x: {
                            beginAtZero: true,
                            max: xMax,
                            grid: { color: "rgb(234, 236, 244)", borderDash: [2], drawBorder: false },
                            ticks: { padding: 10, callback: function(value) { return value + '%' } }
                        },
                        y: {
                            grid: { display: false, drawBorder: false },
                            ticks: { font: { weight: 'bold', size: 11 }, color: "#5a5c69" }
                        }
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            backgroundColor: "rgba(255,255,255,0.95)",
                            bodyColor: "#858796",
                            titleColor: "#6e707e",
                            borderColor: '#dddfeb',
                            borderWidth: 1,
                            callbacks: {
                                label: function(context) { return ` Dropout Rate: ${context.raw}%`; }
                            }
                        }
                    }
                }
            });
        })
        .catch(err => console.error("Ranking Chart Fatal:", err));
}




// scatter plot
function updateGwaScatter(year, college, semester) {
    const canvas = document.getElementById('gwaScatterChart');
    const titleEl = document.getElementById('scatterSubtitle'); // Get the new span
    if (!canvas) return;

    // 1. Update the Header Text Immediately
    if (titleEl) {
        // Format College
        let colText = (college === 'all' || college === '') ? 'Main Campus' : college;
        
        // Format Semester
        let semText = 'All Semesters';
        if (semester.includes('1')) semText = '1st Sem';
        if (semester.includes('2')) semText = '2nd Sem';
        if (semester.toLowerCase().includes('summer')) semText = 'Summer';

        // Set Text: "( 2024 | 1st Sem | CAHS )"
        titleEl.textContent = `( ${year} | ${semText} | ${colText} )`;
    }

    const safeSemester = semester || 'all';

    // 2. Fetch Data
    fetch(`/api/get_gwa_scatter?year=${year}&college=${college}&semester=${safeSemester}`)
        .then(res => res.json())
        .then(data => {
            if (data.error) return console.error("Scatter API Fail:", data.error);

            const ctx = canvas.getContext('2d');

            if (gwaScatterChart) {
                gwaScatterChart.destroy();
            }

            gwaScatterChart = new Chart(ctx, {
                type: 'scatter',
                data: {
                    datasets: [
                        {
                            label: 'Student GWA',
                            data: data.data,
                            backgroundColor: "rgba(78, 115, 223, 0.5)", 
                            borderColor: "#4e73df",
                            borderWidth: 1,
                            pointRadius: 4,
                            pointHoverRadius: 6,
                            order: 2
                        },
                        {
                            type: 'line',
                            label: data.line_label, // "Batch Avg" or "Predicted Avg"
                            data: [
                                { x: 0, y: data.average },
                                { x: 4, y: data.average }
                            ],
                            borderColor: "#e74a3b",
                            borderWidth: 2,
                            borderDash: [6, 4],
                            pointRadius: 0,
                            fill: false,
                            order: 1
                        }
                    ]
                },
                options: {
                    maintainAspectRatio: false,
                    responsive: true,
                    layout: { padding: { left: 10, right: 10, top: 20, bottom: 10 } },
                    scales: {
                        x: { display: false, min: 0, max: 4 },
                        y: {
                            reverse: true, // 1.0 Top
                            min: 1.0,
                            max: 5.0,
                            grid: { color: "rgb(234, 236, 244)", borderDash: [2] },
                            ticks: {
                                stepSize: 0.25,
                                padding: 10,
                                callback: function(value) { return value.toFixed(2); }
                            },
                            title: { display: true, text: 'General Weighted Average' }
                        }
                    },
                    plugins: {
                        legend: { 
                            display: true,
                            position: 'top',
                            labels: { usePointStyle: true }
                        },
                        tooltip: {
                            callbacks: {
                                label: function(context) {
                                    const pt = context.raw;
                                    if (context.dataset.type === 'line') {
                                        return ` ${data.line_label}: ${pt.y}`;
                                    }
                                    return ` ID: ${pt.student_id} | GWA: ${pt.y}`;
                                }
                            }
                        }
                    }
                }
            });
        })
        .catch(err => console.error("Scatter Chart Error:", err));
}






// KPI
function updateKPIMetrics(year, semester, college) {
    const url = `/api/get_kpi_metrics?year=${year}&semester=${semester}&college=${college}`;

    fetch(url)
        .then(res => res.json())
        .then(data => {
            // 1. Get Elements
            const elStudents = document.getElementById('kpi-val-students');
            const elGWA = document.getElementById('kpi-val-gwa');
            const titleStudents = document.getElementById('kpi-title-students');
            const titleGWA = document.getElementById('kpi-title-gwa');
            const cardStudents = document.getElementById('kpi-card-students');
            const cardGWA = document.getElementById('kpi-card-gwa');

            if (!elStudents || !elGWA) return;

            // 2. Update Numbers
            elStudents.innerText = data.students.toLocaleString(); // 1,200
            elGWA.innerText = data.gwa.toFixed(2); // 1.25

            // 3. Dynamic Styling (Blue = History, Orange = AI Prediction)
            const isPred = data.is_prediction;
            const color = isPred ? '#f6ad55' : '#4e73df'; // Orange vs Blue
            const gwaColor = isPred ? '#f6ad55' : '#1cc88a'; // Orange vs Green
            const suffix = isPred ? '(AI Predicted)' : '(Actual)';

            // Apply Colors
            cardStudents.style.borderLeftColor = color;
            titleStudents.style.color = color;
            titleStudents.innerText = `Total Enrollment ${suffix}`;

            cardGWA.style.borderLeftColor = gwaColor;
            titleGWA.style.color = gwaColor;
            titleGWA.innerText = `Average GWA ${suffix}`;
        })
        .catch(err => console.error("KPI Error:", err));
}




//inc line chart
function updateIncForecast(college) {
    const canvas = document.getElementById('incForecastChart');
    if (!canvas) return;

    // Sanitize input
    const safeCollege = (college === 'Main Campus' || !college) ? 'all' : college;

    fetch(`/api/get_inc_forecast?college=${safeCollege}`)
        .then(res => res.json())
        .then(data => {
            if (data.error) return console.error("INC Forecast Error:", data.error);

            const ctx = canvas.getContext('2d');
            const labels = data.years;
            
            // --- DATA PREPARATION ---
            // We need to map the separate 'history' and 'forecast' arrays 
            // to the shared 'years' timeline.
            
            const historyData = [];
            const forecastData = [];
            
            // 1. Fill History (Actuals)
            data.history.forEach(val => {
                historyData.push(val);
                forecastData.push(null); // Placeholder for forecast during history years
            });

            // 2. Bridge the Gap (Optional Visual Polish)
            // Connect the last history point to the first forecast point
            if (data.history.length > 0 && data.forecast.length > 0) {
                // Add the last history value to the start of forecast so lines connect
                forecastData[forecastData.length - 1] = data.history[data.history.length - 1];
            }

            // 3. Fill Forecast (Predictions)
            data.forecast.forEach(val => {
                historyData.push(null); // No history for future
                forecastData.push(val);
            });

            // --- RENDER CHART ---
            if (incForecastChart) {
                incForecastChart.destroy();
            }

            incForecastChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [
                        {
                            label: 'Actual INC Rate',
                            data: historyData,
                            borderColor: '#3e6ff6', // Orange/Yellow
                            backgroundColor: 'rgba(246, 194, 62, 0.1)',
                            borderWidth: 3,
                            pointRadius: 4,
                            pointBackgroundColor: '#3e6ff6',
                            fill: true,
                            tension: 0.3
                        },
                        {
                            label: 'Predicted INC Rate',
                            data: forecastData,
                            borderColor: '#f6c23e',
                            borderDash: [10, 5], // Dashed Line
                            backgroundColor: 'rgba(246, 194, 62, 0.05)',
                            borderWidth: 2,
                            pointRadius: 4,
                            pointStyle: 'rectRot', // Diamond shape for predictions
                            pointBackgroundColor: '#ffffff',
                            pointBorderColor: '#f6c23e',
                            fill: false,
                            tension: 0.3
                        }
                    ]
                },
                options: {
                    maintainAspectRatio: false,
                    scales: {
                        y: {
                            beginAtZero: true, // Important for rates
                            title: { display: true, text: 'INC Rate (%)' },
                            grid: {
                                color: "rgb(234, 236, 244)",
                                borderDash: [2],
                                drawBorder: false
                            },
                            ticks: {
                                padding: 10,
                                callback: function(value) { return value + '%' }
                            }
                        },
                        x: {
                            grid: { display: false },
                            ticks: { maxTicksLimit: 7 }
                        }
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            backgroundColor: "rgba(255,255,255,0.9)",
                            bodyColor: "#858796",
                            titleColor: "#6e707e",
                            borderColor: '#dddfeb',
                            borderWidth: 1,
                            callbacks: {
                                label: function(context) {
                                    let label = context.dataset.label || '';
                                    if (label) label += ': ';
                                    if (context.parsed.y !== null) {
                                        label += context.parsed.y.toFixed(2) + '%';
                                    }
                                    return label;
                                }
                            }
                        }
                    }
                }
            });
        })
        .catch(err => console.error("INC Chart Fatal:", err));
}



// irreg multi line
function updateStatusChart(year, semester, college) {
    const canvas = document.getElementById('statusPieChart');
    if (!canvas) return;

    // 1. Sanitize Inputs
    const safeCollege = (college === 'Main Campus' || !college) ? 'all' : college;
    const safeSemester = semester || 'all';

    // 2. Update Title with Selection
    const titleEl = document.getElementById('status-chart-title');
    if (titleEl) {
        // Format Text: "Main Campus" instead of "all"
        const displayCollege = (safeCollege === 'all') ? 'Main Campus' : safeCollege.toUpperCase();
        const displaySemester = (safeSemester === 'all') ? 'All Sem' : safeSemester;
        
        titleEl.innerText = `Status: ${displayCollege} (${displaySemester})`;
    }

    fetch(`/api/get_status_pie?year=${year}&college=${safeCollege}&semester=${safeSemester}`)
        .then(res => res.json())
        .then(data => {
            if (data.error) return console.error("Status API Error:", data.error);

            // 3. Update Numbers
            const elReg = document.getElementById('val-regular');
            const elIrr = document.getElementById('val-irregular');
            const badge = document.getElementById('status-badge');

            if (elReg) elReg.innerText = `${data.data[0].toLocaleString()}`;
            if (elIrr) elIrr.innerText = `${data.data[1].toLocaleString()}`;
            
            if (badge) {
                badge.innerText = `${data.year} ${data.mode}`;
                badge.style.backgroundColor = data.mode === 'Forecast' ? "#f6c23e" : "#858796";
            }

            // 4. Handle Empty Data
            let chartData = data.data;
            let chartColors = data.colors;
            // If total is 0, show a gray placeholder
            if (data.data.reduce((a,b)=>a+b, 0) === 0) {
                chartData = [1]; 
                chartColors = ["#e3e6f0"];
            }

            const ctx = canvas.getContext('2d');

            // 5. Render Chart
            if (statusPieChart) {
                statusPieChart.data.labels = data.labels;
                statusPieChart.data.datasets[0].data = chartData;
                statusPieChart.data.datasets[0].backgroundColor = chartColors;
                statusPieChart.update(); 
            } else {
                statusPieChart = new Chart(ctx, {
                    type: 'doughnut',
                    data: {
                        labels: data.labels,
                        datasets: [{
                            data: chartData,
                            backgroundColor: chartColors,
                            hoverBackgroundColor: ['#17a673', '#c0392b'], 
                            hoverBorderColor: "rgba(255, 255, 255, 1)",
                            borderWidth: 2,
                            hoverOffset: 8
                        }],
                    },
                    options: {
                        maintainAspectRatio: false,
                        cutout: '70%',
                        responsive: true,
                        animation: {
                            animateScale: true,
                            animateRotate: true,
                            duration: 800,
                            easing: 'easeOutQuart'
                        },
                        plugins: {
                            legend: { display: false },
                            tooltip: {
                                backgroundColor: "rgba(255,255,255,0.9)",
                                bodyColor: "#858796",
                                borderColor: '#dddfeb',
                                borderWidth: 1,
                                titleColor: '#6e707e',
                                callbacks: {
                                    label: function(context) {
                                        if (chartColors[0] === "#e3e6f0") return " No Data";
                                        let val = data.data[context.dataIndex];
                                        let pct = data.percentages[context.dataIndex];
                                        return ` ${context.label}: ${val} (${pct}%)`;
                                    }
                                }
                            }
                        }
                    }
                });
            }
        })
        .catch(err => console.error("Status Pie Fatal:", err));
}