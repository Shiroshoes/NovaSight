let gwaRankingChart;
let dropoutRankingChart;
let gwaTrendChart;
let statusDoughnutChart;
let incForecastChart;

// --- 1. CENTRAL FILTER LOGIC ---
document.addEventListener("DOMContentLoaded", function() {
    const yearSelector = document.getElementById('globalYearFilter');
    const semSelector = document.getElementById('filterSemester');
    const collegeSelector = document.getElementById('filterCollege');

    function triggerUpdate() {
        const year = yearSelector ? yearSelector.value : 2024;
        const semester = semSelector ? semSelector.value : 'all';
        const college = collegeSelector ? collegeSelector.value : 'all';

        console.log(`Updating all charts for: ${year}, ${semester}, ${college}`);

        // Update Bar Charts
        updateGWARanking(year, semester, college);
        updateDropoutRanking(year, semester);
        
        // Update the ML BoxPlot (M/F Distribution)
        updateDropoutBoxPlot(year, semester, college);
        updateGwaTrend(year, college); 
        updateKPIMetrics(year, semester, college);
        updateStatusChart(year, semester, college);
        updateIncForecast(college);
    }

    // Initial load
    triggerUpdate();

    // Listen for changes on all dropdowns
    if (yearSelector) yearSelector.addEventListener('change', triggerUpdate);
    if (semSelector) semSelector.addEventListener('change', triggerUpdate);
    if (collegeSelector) collegeSelector.addEventListener('change', triggerUpdate);
});

function updateDropoutBoxPlot(year, semester, college) {
    console.log("Boxplot update logic placeholder");
}



// M/F distribution GWA
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




//  GWA RANKING CHART (Bar)
function updateGWARanking(year, semester, college) {
    const canvas = document.getElementById('gwaRankingChart');
    if (!canvas) return;

    const collegeColors = {
        'CCST': 'rgba(138, 43, 226, 0.7)',
        'CEA':  'rgba(0, 128, 0, 0.7)',
        'CBA':  'rgba(255, 0, 0, 0.7)',
        'CAHS': 'rgba(173, 216, 230, 0.7)',
        'CTEC': 'rgba(0, 0, 255, 0.7)',
        'CoAS': 'rgb(0, 0, 0)'
    };

    fetch(`/api/get_gwa_ranking_data/${year}?semester=${semester}&college=${college}`)
        .then(res => res.json())
        .then(data => {
            const labels = data.map(item => item.college);
            const values = data.map(item => item.gwa);
            const backgroundColors = labels.map(c => collegeColors[c] || '#ccc');

            const semText = semester === 'all' ? 'Overall' : semester;
            const collText = college === 'all' ? 'All Colleges' : college;
            const newTitle = `BPSU Academic Performance: ${year} (${semText} - ${collText})`;

            if (gwaRankingChart) {
                gwaRankingChart.data.labels = labels;
                gwaRankingChart.data.datasets[0].data = values;
                gwaRankingChart.data.datasets[0].backgroundColor = backgroundColors;
                gwaRankingChart.options.plugins.title.text = newTitle;
                gwaRankingChart.update();
            } else {
                gwaRankingChart = new Chart(canvas.getContext('2d'), {
                    type: 'bar',
                    data: {
                        labels: labels,
                        datasets: [{
                            label: 'Predicted Mean GWA',
                            data: values,
                            backgroundColor: backgroundColors,
                            borderColor: 'rgb(0, 0, 0)',
                            borderWidth: 1
                        }]
                    },
                    options: {
                        responsive: true,
                        plugins: {
                            legend: { display: false },
                            title: { display: true, text: newTitle }
                        },
                        scales: { y: { min: 500, max: 1000, ticks: { stepSize: 50 } } }
                    }
                });
            }
        });
}



// DROPOUT RANKING CHART (Bar)
function updateDropoutRanking(year, semester) {
    const canvas = document.getElementById('dropoutRankingChart');
    if (!canvas) return;

    // Grab the college value directly from the DOM since the filter logic isn't passing it
    const collegeSelector = document.getElementById('filterCollege');
    const college = collegeSelector ? collegeSelector.value : 'all';

    const collegeColors = {
        'CCST': 'rgba(138, 43, 226, 0.7)',
        'CEA':  'rgba(0, 128, 0, 0.7)',
        'CBA':  'rgba(255, 0, 0, 0.7)',
        'CAHS': 'rgba(173, 216, 230, 0.7)',
        'CTEC': 'rgba(0, 0, 255, 0.7)',
        'COAS': 'rgba(0, 0, 0, 0.7)'
    };

    // Added &college=${college} to the fetch call
    fetch(`/api/get_dropout_ranking_data/${year}?semester=${semester}&college=${college}`)
        .then(res => res.json())
        .then(data => {
            const labels = data.map(item => item.college);
            const values = data.map(item => item.risk);
            const colors = labels.map(c => collegeColors[c] || '#ccc');

            const collText = college === 'all' ? 'All Colleges' : college;

            if (dropoutRankingChart) {
                dropoutRankingChart.data.labels = labels;
                dropoutRankingChart.data.datasets[0].data = values;
                dropoutRankingChart.data.datasets[0].backgroundColor = colors;
                dropoutRankingChart.options.plugins.title.text = `BPSU Dropout Risk: ${collText} (${year} - ${semester})`;
                dropoutRankingChart.update();
            } else {
                dropoutRankingChart = new Chart(canvas.getContext('2d'), {
                    type: 'bar',
                    data: {
                        labels: labels,
                        datasets: [{
                            label: 'Risk Probability (%)',
                            data: values,
                            backgroundColor: colors,
                            borderColor: '#333',
                            borderWidth: 1
                        }]
                    },
                    options: {
                        responsive: true,
                        scales: { 
                            y: { 
                                beginAtZero: true,
                                max: 100
                            } 
                        },
                        plugins: {
                            legend: { display: false },
                            title: { display: true, text: `BPSU Dropout Risk: ${collText} (${year} - ${semester})` }
                        }
                    }
                });
            }
        });
}


// scatter plot
function updateGwaTrend(year, college) {
    const canvas = document.getElementById('gwaTrendChart');
    if (!canvas) return;

    fetch(`/api/get_gwa_trend_data/${year}?college=${college}`)
        .then(res => res.json())
        .then(data => {
            const ctx = canvas.getContext('2d');
            const isFuture = data.is_future; 

            // Define visuals based on Future vs Past
            const lineColor = isFuture ? '#f6ad55' : '#e53e3e'; // Orange vs Red
            const lineDash = isFuture ? [10, 5] : []; // Dashed vs Solid
            const titleText = isFuture 
                ? `Predicted Performance Trend: ${year} (${college})`
                : `Actual Performance Trend: ${year} (${college})`;

            if (gwaTrendChart) {
                gwaTrendChart.data.datasets[0].data = data.points; // Scatter points
                gwaTrendChart.data.datasets[1].data = data.trend_line; // The line
                
                // Update styles dynamically
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
                                type: 'scatter',
                                label: 'Student GWA',
                                data: data.points,
                                backgroundColor: 'rgba(66, 153, 225, 0.6)',
                                pointRadius: 6,
                                pointHoverRadius: 8
                            },
                            {
                                type: 'line',
                                label: 'Trend Line',
                                data: data.trend_line,
                                borderColor: lineColor,
                                borderDash: lineDash,
                                borderWidth: 3,
                                fill: false,
                                pointRadius: 0, // Hide points on the line itself
                                tension: 0 // Straight line
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
                        plugins: {
                            legend: { display: false },
                            title: { display: true, text: titleText }
                        }
                    }
                });
            }
        })
        .catch(err => console.error("Trend Chart Error:", err));
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