// --- GLOBAL VARIABLES ---
let gwaTrendChart;
let statusDoughnutChart;
let incForecastChart;
let subjectForecastChart;
let dropoutSpikeChart;

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

        if (typeof updateGwaTrend === 'function') updateGwaTrend(year, semester, college);
        if (typeof updateDropoutBoxPlot === 'function') updateDropoutBoxPlot(year, semester, college);
        
        if (typeof updateKPIMetrics === 'function') updateKPIMetrics(year, semester, college);
        if (typeof updateKPIMetrics === 'function') updateStatusChart(year, semester, college);
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
function updateGwaTrend(year, semester, college) {
    const canvas = document.getElementById('gwaTrendChart');
    if (!canvas) return;

    const url = `/api/get_gwa_trend_data/${year}?college=${college}&semester=${semester}`;

    fetch(url)
        .then(res => res.json())
        .then(data => {
            const ctx = canvas.getContext('2d');
            const isFuture = data.is_future; 

            const lineColor = isFuture ? '#f6ad55' : '#e53e3e'; // Orange vs Red
            const lineDash = isFuture ? [10, 5] : [];
            const semText = semester === 'all' ? 'Overall' : semester;
            
            const titleText = isFuture 
                ? `Predicted Trend: ${year} (${semText})` 
                : `Performance Trend: ${year} (${semText})`;

            if (gwaTrendChart) {
                gwaTrendChart.data.datasets[0].data = data.points; 
                gwaTrendChart.data.datasets[1].data = data.trend_line; 
                gwaTrendChart.data.datasets[1].borderColor = lineColor;
                gwaTrendChart.data.datasets[1].borderDash = lineDash;
                gwaTrendChart.options.plugins.title.text = titleText;
                gwaTrendChart.update();
            } else {
                gwaTrendChart = new Chart(ctx, {
                    type: 'scatter',
                    data: {
                        datasets: [
                            {
                                label: 'Student GWA',
                                data: data.points,
                                backgroundColor: 'rgba(54, 162, 235, 0.6)',
                                pointRadius: 5, 
                                pointHoverRadius: 7
                            },
                            {
                                type: 'line',
                                label: isFuture ? 'Prediction' : 'Trend Line',
                                data: data.trend_line,
                                borderColor: lineColor,
                                borderDash: lineDash,
                                borderWidth: 3,
                                fill: false,
                                pointRadius: 0,
                                tension: 0
                            }
                        ]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        scales: {
                            x: { 
                                type: 'linear', 
                                min: 0.5, max: 2.5, 
                                title: { display: true, text: 'Semester' },
                                ticks: { stepSize: 1, callback: (v) => (v===1 ? '1st Sem' : v===2 ? '2nd Sem' : '') } 
                            },
                            y: { 
                                min: 500, max: 1000, 
                                title: { display: true, text: 'GWA Score' } 
                            }
                        },
                        plugins: { legend: { display: false }, title: { display: true, text: titleText } }
                    }
                });
            }
        })
        .catch(err => console.error("Scatter Plot Error:", err));
}


// --- 2. IMAGE: DROPOUT BOXPLOT ---
function updateDropoutBoxPlot(year, semester, college) {
    const chartImg = document.getElementById('dropoutBoxPlotImg_all');
    const loader = document.getElementById('chart-loader');

    if (!chartImg) return;

    fetch(`/api/get_boxplot_chart/${college}?year=${year}&semester=${semester}`)
        .then(res => res.json())
        .then(data => {
            if (data.chart_url) {
                chartImg.src = data.chart_url;
                chartImg.style.display = 'block';
                if (loader) loader.style.display = 'none';
            }
        })
        .catch(err => console.error("Boxplot Error:", err));
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
    const canvas = document.getElementById('statusDoughnutChart');
    const noDataMsg = document.getElementById('status-no-data');
    const badge = document.getElementById('status-year-badge');
    
    if (!canvas) return;

    fetch(`/api/get_status_distribution?year=${year}&semester=${semester}&college=${college}`)
        .then(res => res.json())
        .then(data => {
            // 1. DEBUG: Check what the API returned
            console.log("Pie Data:", data);

            // 2. Update Badge (Safe Check)
            if(badge) badge.innerText = `${data.year || year} Projection`;

            // 3. Handle Errors or Empty Data
            if (data.error || data.total === 0) {
                console.warn("Chart Skipped:", data.error || "No Data");
                canvas.style.display = 'none';
                if(noDataMsg) {
                    noDataMsg.innerText = data.error ? "Analysis Failed" : "No Data Available";
                    noDataMsg.style.display = 'block';
                }
                return;
            }

            // 4. Success: Show Canvas
            canvas.style.display = 'block';
            if(noDataMsg) noDataMsg.style.display = 'none';

            const ctx = canvas.getContext('2d');

            if (statusDoughnutChart) {
                statusDoughnutChart.data.labels = data.labels;
                statusDoughnutChart.data.datasets[0].data = data.data;
                statusDoughnutChart.data.datasets[0].backgroundColor = data.colors;
                statusDoughnutChart.update();
            } else {
                statusDoughnutChart = new Chart(ctx, {
                    type: 'doughnut',
                    data: {
                        labels: data.labels,
                        datasets: [{
                            data: data.data,
                            backgroundColor: data.colors,
                            hoverBorderColor: "rgba(234, 236, 244, 1)",
                            borderWidth: 2,
                            hoverOffset: 4
                        }],
                    },
                    options: {
                        maintainAspectRatio: false,
                        cutout: '70%',
                        plugins: {
                            legend: { display: false },
                            tooltip: {
                                callbacks: {
                                    label: function(context) {
                                        let label = context.label || '';
                                        let value = context.raw || 0;
                                        let total = context.chart._metasets[context.datasetIndex].total;
                                        let percentage = Math.round((value / total) * 100) + '%';
                                        return ` ${label}: ${value} (${percentage})`;
                                    }
                                }
                            }
                        },
                        // FALLBACK for older Chart.js (v2)
                        legend: { display: false },
                        tooltips: {
                            callbacks: {
                                label: function(tooltipItem, data) {
                                    let label = data.labels[tooltipItem.index] || '';
                                    let value = data.datasets[0].data[tooltipItem.index];
                                    return ` ${label}: ${value}`;
                                }
                            }
                        }
                    },
                });
            }
        })
        .catch(err => {
            console.error("Doughnut Chart Fatal Error:", err);
            if(badge) badge.innerText = "Connection Error";
        });
}



//
//inc line chart
function updateIncForecast(college) {
    const canvas = document.getElementById('incForecastChart');
    if (!canvas) return;

    // Note: We don't need Year/Sem filters for this, as it shows the full timeline
    fetch(`/api/get_inc_forecast?college=${college}`)
        .then(res => res.json())
        .then(data => {
            if (data.error) return;

            const ctx = canvas.getContext('2d');
            
            // Combine labels (History + Future)
            const allLabels = [...data.years_hist, ...data.years_pred];
            
            // Create Data Arrays with "Null" to separate lines
            // Dataset 1 (History): [Values, ..., null, null]
            // Dataset 2 (Future):  [null, ..., LastHistValue, PredValues]
            
            const histData = data.data_hist;
            
            // To connect the lines, the future line must start with the last historical value
            const lastHistVal = histData[histData.length - 1];
            const predData = [lastHistVal, ...data.data_pred]; 

            // Pad the arrays to match 'allLabels' length
            // History padding
            const histDisplay = [...histData]; 
            // Future padding: Needs 'null' for every historical year (minus 1 for the overlap)
            const predPadding = new Array(data.years_hist.length - 1).fill(null);
            const predDisplay = [...predPadding, ...predData];

            if (incForecastChart) {
                incForecastChart.destroy(); // Destroy old to cleanly redraw (Line charts can be tricky with length changes)
            }

            incForecastChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: allLabels,
                    datasets: [
                        {
                            label: 'Historical INC Rate (%)',
                            data: histDisplay,
                            borderColor: '#4e73df', // Blue
                            backgroundColor: 'rgba(78, 115, 223, 0.1)',
                            tension: 0.3,
                            fill: true
                        },
                        {
                            label: 'Predicted Trend',
                            data: predDisplay,
                            borderColor: '#f6c23e', // Yellow/Orange
                            borderDash: [10, 5], // Dashed Line
                            pointBackgroundColor: '#f6c23e',
                            tension: 0.3,
                            fill: false
                        }
                    ]
                },
                options: {
                    maintainAspectRatio: false,
                    scales: {
                        y: {
                            beginAtZero: true,
                            title: { display: true, text: 'INC Rate (%)' }
                        },
                        x: {
                            grid: { display: false }
                        }
                    },
                    plugins: {
                        tooltip: {
                            mode: 'index',
                            intersect: false
                        }
                    }
                }
            });
        })
        .catch(err => console.error("INC Chart Error:", err));
}



//multi line subject top
function updateSubjectForecast(college) {
    const canvas = document.getElementById('subjectForecastChart');
    if (!canvas) return;

    // API call
    fetch(`/api/get_subject_forecast?college=${college}`)
        .then(res => res.json())
        .then(data => {
            // 1. Safety Check: Did we get data?
            if (data.error) {
                console.warn("Subject Chart Error:", data.error);
                return;
            }
            if (!data.datasets || data.datasets.length === 0) {
                console.warn("Subject Chart: No subjects found. Check CSV 'Subject' column.");
                return;
            }

            const ctx = canvas.getContext('2d');

            if (subjectForecastChart) {
                subjectForecastChart.destroy(); 
            }

            subjectForecastChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: data.labels, 
                    datasets: data.datasets 
                },
                options: {
                    maintainAspectRatio: false,
                    interaction: {
                        mode: 'index',
                        intersect: false,
                    },
                    scales: {
                        y: {
                            title: { display: true, text: 'Grade Score' },
                            // --- THE FIX: AUTO-SCALE ---
                            // We removed 'min: 1', 'max: 5', and 'reverse: true'
                            // Now it handles your 800-1000 scale automatically.
                            ticks: {
                                padding: 10
                            },
                            grid: {
                                color: "rgb(234, 236, 244)",
                                zeroLineColor: "rgb(234, 236, 244)",
                                drawBorder: false,
                                borderDash: [2],
                                zeroLineBorderDash: [2]
                            }
                        },
                        x: {
                            title: { display: true, text: 'Academic Year' },
                            grid: {
                                display: false,
                                drawBorder: false
                            },
                            ticks: {
                                maxTicksLimit: 7
                            }
                        }
                    },
                    plugins: {
                        legend: {
                            position: 'bottom',
                            labels: { 
                                boxWidth: 12, 
                                usePointStyle: true,
                                padding: 20
                            }
                        }
                    }
                }
            });
        })
        .catch(err => console.error("Subject Chart Fatal Error:", err));
}





// spike drop
function updateDropoutSpike(college) {
    const canvas = document.getElementById('dropoutSpikeChart');
    // Add a container for error messages in your HTML or find the parent
    if (!canvas) {
        console.warn("Dropout Canvas not found in HTML");
        return;
    }

    fetch(`/api/get_dropout_spike?college=${college}`)
        .then(res => res.json())
        .then(data => {
            // 1. ERROR HANDLING
            if (data.error) {
                console.error("Dropout API Error:", data.error);
                // Optional: Display error text on the card
                const ctx = canvas.getContext('2d');
                ctx.font = "14px Arial";
                ctx.fillText("Error: " + data.error, 10, 50);
                return;
            }
            
            // 2. EMPTY DATA HANDLING
            if (!data.data || data.data.length === 0) {
                console.warn("Dropout API returned no data");
                return;
            }

            const ctx = canvas.getContext('2d');
            
            // DYNAMIC COLORS (Red for Spike, Blue for Normal)
            const pointColors = data.spikes.map(isSpike => isSpike ? '#e74a3b' : '#4e73df');
            const pointRadii = data.spikes.map(isSpike => isSpike ? 6 : 4);

            if (dropoutSpikeChart) {
                dropoutSpikeChart.destroy();
            }

            dropoutSpikeChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: data.labels,
                    datasets: [{
                        label: 'Dropout Rate (%)',
                        data: data.data,
                        borderColor: '#858796', 
                        backgroundColor: 'rgba(78, 115, 223, 0.05)',
                        borderWidth: 2,
                        // Point Styling
                        pointBackgroundColor: pointColors,
                        pointBorderColor: pointColors,
                        pointRadius: pointRadii,
                        pointHoverRadius: 8,
                        tension: 0.3,
                        fill: true
                    }]
                },
                options: {
                    maintainAspectRatio: false,
                    interaction: {
                        mode: 'index',
                        intersect: false,
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            title: { display: true, text: 'Dropout Rate (%)' },
                            grid: { borderDash: [2] }
                        },
                        x: {
                            grid: { display: false }
                        }
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: function(context) {
                                    let val = context.parsed.y;
                                    let label = `Rate: ${val}%`;
                                    if (data.spikes[context.dataIndex]) {
                                        label += ' (⚠️ SPIKE)';
                                    }
                                    return label;
                                }
                            }
                        }
                    }
                }
            });
        })
        .catch(err => console.error("Dropout Chart Fatal Error:", err));
}