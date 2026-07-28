// This is the ONLY hardcoded value in this file — see dashboard.js for
// the same rationale (a static extension popup has no way to read the
// backend's .env directly).
const BACKEND_ORIGIN = "http://127.0.0.1:8000";

const connectionDot =
    document.getElementById("connectionDot");

const connectionText =
    document.getElementById("connectionText");

let CONFIG = null;

async function loadConfig() {
    if (CONFIG) {
        return CONFIG;
    }
    const response = await fetch(`${BACKEND_ORIGIN}/config`);
    CONFIG = await response.json();
    return CONFIG;
}

async function loadTelemetry() {

    try {

        const config = await loadConfig();

        const response = await fetch(`${config.api_url}/telemetry/latest`);

        const telemetry = await response.json();

        connectionDot.className = "dot connected";

        connectionText.textContent = "Connected";

        document.getElementById("lastUpdate").textContent =
        new Date().toLocaleTimeString();

        if (telemetry.message) {
            return;
        }

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

        const statusElement =
            document.getElementById("status");

        statusElement.textContent = telemetry.status;

        statusElement.className = "";

        if (telemetry.status === "Nominal") {

            statusElement.classList.add("nominal");

        }

        else if (telemetry.status === "Warning") {

            statusElement.classList.add("warning");

        }

        else if (telemetry.status === "Critical") {

            statusElement.classList.add("critical");

        }

    }

    catch(error){
        console.error(error);
        connectionDot.className = "dot disconnected";
        connectionText.textContent = "Disconnected";
    }

}

async function init() {

    const config = await loadConfig();

    // Load immediately
    loadTelemetry();

    // Refresh at the same cadence the backend simulator sends telemetry,
    // instead of a separately hardcoded interval that could drift out of
    // sync with it.
    setInterval(() => {

        loadTelemetry();

    }, config.update_rate * 1000);

    document
        .getElementById("openDashboard")
        .addEventListener("click", () => {

            chrome.tabs.create({
                url: config.dashboard_url
            });

        });

    document
        .getElementById("refreshButton")
        .addEventListener("click", () => {

            loadTelemetry();

        });

}

init();