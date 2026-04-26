
let statusPieChart;
let incForecastChart;
let subjectForecastChart;
let dropoutSpikeChart;
let dropoutPieChart; 
let gwaScatterChart;

document.addEventListener("DOMContentLoaded", function() {
    console.log("--- Dashboard Logic Loaded ---");

    // GET FILTERS
    const yearSelector = document.getElementById('globalYearFilter');
    const semSelector = document.getElementById('filterSemester');

    // MASTER TRIGGER FUNCTION
    function triggerUpdate() {
        // Get Values (Default to 2024/all if elements are missing)
        const year = yearSelector ? yearSelector.value : 2024;
        const semester = semSelector ? semSelector.value : 'all';
        
        // CRITICAL: Uses the Python variable injected into HTML
        const college = (typeof COLLEGE_NAME !== 'undefined') ? COLLEGE_NAME : 'all';

        if (college === 'all') {
            console.warn(" Warning: COLLEGE_NAME is 'all'. Is the Python variable set correctly?");
        }

        console.log(` Fetching Data for: ${college} | Year: ${year} | Sem: ${semester}`);

        if (typeof updateGwaScatter === 'function') updateGwaScatter(year, college, semester);
        if (typeof updateDropoutPie === 'function') updateDropoutPie(year, college);
        
        if (typeof updateKPIMetrics === 'function') updateKPIMetrics(year, semester, college);
        if (typeof updateStatusChart === 'function') updateStatusChart(year, semester, college);
        if (typeof updateKPIMetrics === 'function') updateIncForecast(college);
        if (typeof updateSubjectForecast === 'function') updateSubjectForecast(college);
        if (typeof updateDropoutSpike === 'function') updateDropoutSpike(college);
    
    }

    // 3. INITIAL LOAD
    triggerUpdate();

    // 4. LISTENERS
    if (yearSelector) yearSelector.addEventListener('change', triggerUpdate);
    if (semSelector) semSelector.addEventListener('change', triggerUpdate);
});


// --- 1. CHART: GWA TREND SCATTER PLOT ---
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


// ---DROPOUT chart ---
function updateDropoutPie(year, college) {
    const semDropdown = document.getElementById('filterSemester');
    const semester = semDropdown ? semDropdown.value : 'all';
    
    const canvas = document.getElementById('dropoutPieChart');
    const collegeLabel = document.getElementById('dp-college-name'); 
    const badge = document.getElementById('drop-pie-badge');         

    fetch(`/api/get_dropout_pie?year=${year}&college=${college}&semester=${semester}`)
        .then(res => res.json())
        .then(data => {
            // 1. Update Badge and Title Header
            if(badge) {
                badge.innerText = `${year} ${data.mode}`;
                badge.style.backgroundColor = data.mode === "Forecast" ? "#ffc107" : "#858796";
            }
            if (collegeLabel) {
                const cName = data.display_college === 'ALL' ? 'Main Campus' : data.display_college;
                const sName = data.display_sem === 'ALL' ? 'All Semesters' : data.display_sem;
                collegeLabel.innerText = `${cName} - ${sName}`;
            }

            // 3. Update Sidebar (Strict Index Mapping)
            // Indices: 0:M-Reg, 1:M-INC, 2:M-Drop | 3:F-Reg, 4:F-INC, 5:F-Drop
            // Inside your fetch .then block
            const counts = data.data;

            // Update Female Sidebar Values
            if(document.getElementById('f-reg'))  document.getElementById('f-reg').innerText  = counts[3];
            if(document.getElementById('f-inc'))  document.getElementById('f-inc').innerText  = counts[4];
            if(document.getElementById('f-drop')) document.getElementById('f-drop').innerText = counts[5];

            // Update Male Sidebar Values
            if(document.getElementById('m-reg'))  document.getElementById('m-reg').innerText  = counts[0];
            if(document.getElementById('m-inc'))  document.getElementById('m-inc').innerText  = counts[1];
            if(document.getElementById('m-drop')) document.getElementById('m-drop').innerText = counts[2];


            // 4. Update / Render Chart
            const ctx = canvas.getContext('2d');
            if (dropoutPieChart) dropoutPieChart.destroy();

            dropoutPieChart = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: data.labels,
                    datasets: [{
                        data: data.data,
                        backgroundColor: data.colors,
                        borderWidth: 2
                    }]
                },
                options: {
                    maintainAspectRatio: false,
                    cutout: '70%',
                    animation: {
                        animateScale: true,
                        animateRotate: true,
                        duration: 800,
                        easing: 'easeOutQuart'
                    },
                    plugins: { 
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: (ctx) => ` ${ctx.label}: ${ctx.raw} (${Math.round((ctx.raw/data.total)*100)}%)`
                            }
                        }
                    }
                }
            });
        });
}



// 3. KPI METRICS (Total Students & GWA)
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

            if (!elStudents || !elGWA) {
                console.warn("KPI Elements not found in HTML.");
                return;
            }

            // 2. Update Values (Prevent null/undefined errors)
            const safeStudents = data.students !== undefined ? data.students : 0;
            const safeGWA = data.gwa !== undefined ? data.gwa : 0;

            elStudents.innerText = safeStudents.toLocaleString(); 
            elGWA.innerText = Number(safeGWA).toFixed(2);

            // 3. Dynamic Styling (Blue = History, Orange = AI Prediction)
            const isPred = data.is_prediction;
            
            // Colors
            const colorPrimary = isPred ? '#f6ad55' : '#4e73df'; // Orange vs Blue
            const colorSecondary = isPred ? '#f6ad55' : '#c81c1c'; // Orange vs Green
            const suffix = isPred ? '(AI Predicted)' : '(Actual)';

            // Apply Styles: Students Card
            if(cardStudents) cardStudents.style.borderLeftColor = colorPrimary;
            if(titleStudents) {
                titleStudents.style.color = colorPrimary;
                titleStudents.innerText = `Total Enrollment ${suffix}`;
            }

            // Apply Styles: GWA Card
            if(cardGWA) cardGWA.style.borderLeftColor = colorSecondary;
            if(titleGWA) {
                titleGWA.style.color = colorSecondary;
                titleGWA.innerText = `Average GWA ${suffix}`;
            }
        })
        .catch(err => console.error("KPI Error:", err));
}






// piechart
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
                            borderColor: '#f6c23e', // Orange/Yellow
                            backgroundColor: 'rgba(246, 194, 62, 0.1)',
                            borderWidth: 3,
                            pointRadius: 4,
                            pointBackgroundColor: '#f6c23e',
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


//multi line subject top
function updateSubjectForecast(college) {
    const canvas = document.getElementById('subjectForecastChart');
    if (!canvas) return;

    const safeCollege = (college === 'Main Campus' || !college) ? 'all' : college;

    console.log(`Fetching Subject Forecast for: ${safeCollege}`);

    fetch(`/api/get_subject_forecast?college=${safeCollege}`)
        .then(res => res.json())
        .then(data => {
            if (data.error || !data.datasets) {
                console.warn("Subject API Error or Empty:", data.error);
                return;
            }

            const ctx = canvas.getContext('2d');
            
            // Distinct Colors for the 5 lines
            const colors = ['#e74a3b', '#f6c23e', '#4e73df', '#1cc88a', '#36b9cc'];

            const chartDatasets = data.datasets.map((ds, index) => ({
                label: ds.label,
                data: ds.data,
                borderColor: colors[index % colors.length],
                backgroundColor: 'transparent',
                borderWidth: 2,
                tension: 0.3, 
                pointRadius: 3,
                
                // --- CRITICAL FIX: Connects lines across missing data ---
                spanGaps: true, 
                
                // Dashed line for Forecast (Index 3+ is 2025)
                segment: {
                    borderDash: ctx => ctx.p0DataIndex >= 2 ? [5, 5] : undefined
                }
            }));

            if (subjectForecastChart) {
                subjectForecastChart.destroy();
            }

            subjectForecastChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: data.labels, // [2022, 2023, 2024, 2025...]
                    datasets: chartDatasets
                },
                options: {
                    maintainAspectRatio: false,
                    interaction: {
                        mode: 'nearest',
                        axis: 'x',
                        intersect: false
                    },
                    plugins: {
                        legend: { 
                            display: true,
                            position: 'top',
                            align: 'start',
                            labels: { boxWidth: 10, font: { size: 10 } }
                        },
                        tooltip: {
                            callbacks: {
                                label: function(context) {
                                    return ` ${context.dataset.label}: ${context.parsed.y.toFixed(2)}`;
                                }
                            }
                        },
                        annotation: {
                            annotations: {
                                line1: {
                                    type: 'line',
                                    xMin: 2, // Index of 2024
                                    xMax: 2,
                                    borderColor: 'rgba(0,0,0,0.2)',
                                    borderWidth: 1,
                                    borderDash: [4, 4],
                                    label: { 
                                        content: 'Forecast Start', 
                                        enabled: true, 
                                        position: 'bottom', 
                                        color: '#858796',
                                        font: {size: 10}
                                    }
                                }
                            }
                        }
                    },
                    scales: {
                        y: {
                            reverse: true, // 1.0 is Top
                            min: 1.0,      // Start at 1.0
                            max: 3.5,      // Cap at 3.5 to see details
                            title: { display: true, text: 'Grade (Lower is Better)' },
                            grid: { borderDash: [2], color: "#eaecf4" }
                        },
                        x: {
                            grid: { display: false }
                        }
                    }
                }
            });
        })
        .catch(err => console.error("Subject Chart Fatal:", err));
}





// spike drop
function updateDropoutSpike(college) {
    const canvas = document.getElementById('dropoutSpikeChart');
    if (!canvas) return;

    const safeCollege = (college === 'Main Campus' || !college) ? 'all' : college;

    fetch(`/api/get_dropout_spike?college=${safeCollege}`)
        .then(res => res.json())
        .then(data => {
            if (data.error || !data.data) {
                console.warn("Dropout Spike: No Data");
                return;
            }

            const ctx = canvas.getContext('2d');
            const predictionStartIndex = data.pred_start_index || (data.labels.length - 5);

            // Point Styles: Red for Spike, Blue for Normal
            const pointColors = data.spikes.map(s => s ? '#e74a3b' : '#4e73df');
            const pointRadii = data.spikes.map(s => s ? 6 : 3);
            const pointStyles = data.spikes.map(s => s ? 'circle' : 'circle');

            if (dropoutSpikeChart) {
                dropoutSpikeChart.destroy();
            }

            dropoutSpikeChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: data.labels,
                    datasets: [{
                        label: 'Dropout Rate',
                        data: data.data,
                        borderColor: '#4e73df',
                        backgroundColor: 'rgba(78, 115, 223, 0.05)',
                        borderWidth: 2,
                        pointBackgroundColor: pointColors,
                        pointBorderColor: "#fff",
                        pointRadius: pointRadii,
                        pointStyle: pointStyles,
                        pointHoverRadius: 8,
                        tension: 0.3, // Smooth curve
                        fill: true,
                        // --- CRITICAL: DASHED LINE FOR PREDICTION ---
                        segment: {
                            borderDash: ctx => {
                                // If the segment starts after history, make it dashed
                                if (ctx.p0DataIndex >= predictionStartIndex) {
                                    return [6, 6]; 
                                }
                                return undefined;
                            }
                        }
                    }]
                },
                options: {
                    maintainAspectRatio: false,
                    interaction: {
                        mode: 'index',
                        intersect: false,
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
                                label: function(context) {
                                    let val = context.parsed.y;
                                    let status = context.dataIndex > predictionStartIndex ? "(Forecast)" : "(Actual)";
                                    let spikeMsg = data.spikes[context.dataIndex] ? "SPIKE" : "";
                                    return ` Rate: ${val}% ${status} ${spikeMsg}`;
                                }
                            }
                        },
                        annotation: {
                            // Optional: Vertical line separator
                            annotations: {
                                line1: {
                                    type: 'line',
                                    xMin: predictionStartIndex,
                                    xMax: predictionStartIndex,
                                    borderColor: 'rgba(0,0,0,0.2)',
                                    borderWidth: 1,
                                    borderDash: [2, 2],
                                    label: {
                                        content: 'Forecast Start',
                                        enabled: true,
                                        position: 'top'
                                    }
                                }
                            }
                        }
                    },
                    scales: {
                        x: {
                            grid: { display: false },
                            ticks: { color: "#858796" }
                        },
                        y: {
                            beginAtZero: true,
                            title: { display: true, text: 'Dropout Rate (%)' },
                            grid: { color: "rgb(234, 236, 244)", borderDash: [2] },
                            ticks: { color: "#858796", padding: 10 }
                        }
                    }
                }
            });
        })
        .catch(err => console.error("Dropout Chart Fatal:", err));
}