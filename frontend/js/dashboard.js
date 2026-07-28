// =========================
// Backend Bootstrap
// =========================
// This is the ONLY hardcoded value in this file. A static HTML/JS page
// has no way to read the backend's .env directly — it has to know where
// to ask. Everything else (WebSocket URL, REST API origin, project name,
// update rate, satellite name) is fetched from the backend's centralized
// configuration below.
const BACKEND_ORIGIN = "http://127.0.0.1:8000";

// =========================
// Leaflet Map (does not depend on backend config)
// =========================

const map = L.map("map").setView([0, 0], 2);

L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
        attribution:
            "&copy; OpenStreetMap contributors"
    }
).addTo(map);

const satelliteMarker = L.marker([0, 0])
    .addTo(map)
    .bindPopup("Loading satellite data...");

// =========================
// Orbit Trail
// =========================

const orbitPath = L.polyline(
    [],
    {
        color: "#00E5FF",
        weight: 3
    }
).addTo(map);

// =========================
// Tracking Mode
// =========================

let trackingEnabled = true;

const trackingButton =
    document.getElementById("trackingButton");

trackingButton.textContent = "Tracking: ON";
trackingButton.style.backgroundColor = "#4CAF50";

trackingButton.addEventListener("click", () => {

    trackingEnabled = !trackingEnabled;

    if (trackingEnabled) {

        trackingButton.textContent = "Tracking: ON";
        trackingButton.style.backgroundColor = "#4CAF50";

    } else {

        trackingButton.textContent = "Tracking: OFF";
        trackingButton.style.backgroundColor = "#F44336";

    }

});

// =========================
// Create a reusable chart
// =========================


function createTelemetryChart(canvasId, label, color) {

    return new Chart(

        document.getElementById(canvasId),

        {

            type: "line",

            data: {

                labels: [],

                datasets: [

                    {

                        label: label,

                        data: [],

                        borderColor: color,

                        backgroundColor: color,

                        borderWidth: 2,

                        tension: 0.3,

                        pointRadius: 2,

                        fill: false

                    }

                ]

            },

            options: {

                responsive: true,

                maintainAspectRatio: false,

                animation: false,

                scales: {

                    x: {

                        ticks: {

                            color: "#cccccc"

                        },

                        grid: {

                            color: "#333333"

                        }

                    },

                    y: {

                        ticks: {

                            color: "#cccccc"

                        },

                        grid: {

                            color: "#333333"

                        }

                    }

                },

                plugins: {

                    legend: {

                        labels: {

                            color: "#ffffff"

                        }

                    }

                }

            }

        }

    );

}

// =========================
// Create the charts
// =========================

const batteryChart = createTelemetryChart(
    "batteryChart",
    "Battery (%)",
    "#4CAF50"
);

const temperatureChart = createTelemetryChart(
    "temperatureChart",
    "Temperature (°C)",
    "#FF9800"
);

const cpuChart = createTelemetryChart(
    "cpuChart",
    "CPU (%)",
    "#03A9F4"
);

function addPoint(chart, label, value) {

    chart.data.labels.push(label);

    chart.data.datasets[0].data.push(value);

    // Keep only the latest 20 samples
    if (chart.data.labels.length > 20) {

        chart.data.labels.shift();

        chart.data.datasets[0].data.shift();

    }

    chart.update();

}

function updateDashboard(telemetry) {

    document.getElementById("satelliteCard").textContent =
        telemetry.satellite_id;

    document.getElementById("statusCard").textContent =
        telemetry.status;

    document.getElementById("batteryCard").textContent =
        telemetry.battery + " %";

    document.getElementById("signalCard").textContent =
        telemetry.signal_strength + " %";

    document.getElementById("satellite").textContent =
        telemetry.satellite_id;

    document.getElementById("battery").textContent =
        telemetry.battery + " %";

    document.getElementById("temperature").textContent =
        telemetry.temperature + " °C";

    document.getElementById("signal").textContent =
        telemetry.signal_strength + " %";

    document.getElementById("cpu").textContent =
        telemetry.cpu_load + " %";

    document.getElementById("status").textContent =
        telemetry.status;

    document.getElementById("timestamp").textContent =
        telemetry.timestamp;

    document.getElementById("latitude").textContent =
    telemetry.latitude.toFixed(4) + "°";

    document.getElementById("longitude").textContent =
    telemetry.longitude.toFixed(4) + "°";

    document.getElementById("altitude").textContent =
    telemetry.altitude.toFixed(2) + " km";

    document.getElementById("velocity").textContent =
    telemetry.velocity.toFixed(2) + " km/s";

    const label = new Date(
        telemetry.timestamp
    ).toLocaleTimeString();

    addPoint(
        batteryChart,
        label,
        telemetry.battery
    );

    addPoint(
        temperatureChart,
        label,
        telemetry.temperature
    );

    addPoint(
        cpuChart,
        label,
        telemetry.cpu_load
    );

    // =========================
    // // // Update satellite marker
    // // =========================
    satelliteMarker.setLatLng([
        telemetry.latitude,
        telemetry.longitude
    ]);

    if (trackingEnabled){
        map.panTo(
            [
                telemetry.latitude,
                telemetry.longitude
            ],
            {
                animate:true
            }
        );
    }

    satelliteMarker.setPopupContent(`
        <b>${telemetry.satellite_id}</b>
        <hr>
        <b>Latitude:</b> ${telemetry.latitude.toFixed(4)}°<br>
        <b>Longitude:</b> ${telemetry.longitude.toFixed(4)}°<br>
        <b>Altitude:</b> ${telemetry.altitude.toFixed(2)} km<br>
        <b>Velocity:</b> ${telemetry.velocity.toFixed(2)} km/s<br>
        <b>Battery:</b> ${telemetry.battery.toFixed(2)} %<br>
        <b>Temperature:</b> ${telemetry.temperature.toFixed(2)} °C<br>
        <b>Signal:</b> ${telemetry.signal_strength.toFixed(2)} %<br>
        <b>CPU:</b> ${telemetry.cpu_load.toFixed(2)} %<br>
        <b>Status:</b> ${telemetry.status}<br>
        <b>Timestamp:</b><br>
        ${new Date(telemetry.timestamp).toLocaleString()}
    `);

    satelliteMarker.openPopup();

    // =========================
    // // Update orbit trail
    // // =========================
    orbitPath.addLatLng([
        telemetry.latitude,
        telemetry.longitude
    ]);

    // Keep only the latest 100 positions
    if (orbitPath.getLatLngs().length > 100) {
        orbitPath.setLatLngs(
            orbitPath.getLatLngs().slice(-100)
        );
    }

}

// =========================
// Backend-config-dependent bootstrap
// =========================
// Everything that needs to know the backend's real URLs waits for this
// to complete, instead of being hardcoded at module-load time.

async function initDashboard() {

    let config;

    try {

        const response = await fetch(`${BACKEND_ORIGIN}/config`);
        config = await response.json();

    } catch (error) {

        console.error("Failed to load backend configuration:", error);
        return;

    }

    // =========================
    // WebSocket Connection
    // =========================

    const socket = new WebSocket(config.websocket_url);

    socket.onopen = () => {
        console.log(`Connected to ${config.project_name}`);
    };

    socket.onmessage = (event) => {
        const telemetry = JSON.parse(event.data);
        updateDashboard(telemetry);
    };

    socket.onclose = () => {
        console.log("Disconnected from Mission Control");
    };

    // =========================
    // Load latest telemetry
    // =========================

    async function loadLatestTelemetry() {

        try {

            const response = await fetch(
                `${config.api_url}/telemetry/latest`
            );

            const telemetry = await response.json();

            if (telemetry.message) {
                return;
            }

            updateDashboard(telemetry);

        } catch (error) {

            console.error(
                "Failed to load latest telemetry:",
                error
            );

        }

    }

    loadLatestTelemetry();

}

initDashboard();