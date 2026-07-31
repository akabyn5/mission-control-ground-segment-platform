// This is the ONLY hardcoded value in this file.
// The extension cannot directly read the backend .env file.
const BACKEND_ORIGIN = "http://127.0.0.1:8000";

const connectionDot =
    document.getElementById("connectionDot");

const connectionText =
    document.getElementById("connectionText");

const lastUpdateElement =
    document.getElementById("lastUpdate");

const errorMessageElement =
    document.getElementById("errorMessage");

const subsystemListElement =
    document.getElementById("subsystemList");

const alarmListElement =
    document.getElementById("alarmList");

let CONFIG = null;

// Fallback only for compatibility if an older backend does not yet expose
// the subsystem list through GET /config.
const FALLBACK_SUBSYSTEMS = [
    { key: "power", label: "Power" },
    { key: "thermal", label: "Thermal" },
    { key: "communications", label: "Communications" },
    { key: "adcs", label: "ADCS" },
    { key: "payload", label: "Payload" }
];

function getStatusClass(status) {
    if (status === "Nominal") {
        return "nominal";
    }

    if (status === "Warning") {
        return "warning";
    }

    if (status === "Critical") {
        return "critical";
    }

    return "";
}

function setConnectionState(connected) {
    if (connected) {
        connectionDot.className = "dot connected";
        connectionText.textContent = "Connected";
    } else {
        connectionDot.className = "dot disconnected";
        connectionText.textContent = "Disconnected";
    }
}

function clearError() {
    errorMessageElement.textContent = "";
}

function showError(message) {
    errorMessageElement.textContent = message;
}

async function loadConfig() {
    if (CONFIG) {
        return CONFIG;
    }

    const response = await fetch(`${BACKEND_ORIGIN}/config`);

    if (!response.ok) {
        throw new Error(
            `Configuration request failed with HTTP ${response.status}`
        );
    }

    CONFIG = await response.json();

    return CONFIG;
}

function buildSubsystemRows(subsystems) {
    subsystemListElement.innerHTML = "";

    const subsystemDefinitions =
        Array.isArray(subsystems) && subsystems.length > 0
            ? subsystems
            : FALLBACK_SUBSYSTEMS;

    for (const subsystem of subsystemDefinitions) {
        const row = document.createElement("div");

        row.className = "subsystem-row";

        row.innerHTML = `
            <span
                class="subsystem-name"
                data-subsystem-name="${subsystem.key}">
                ${subsystem.label}
            </span>

            <span
                id="subsystem-${subsystem.key}"
                class="subsystem-badge nominal">
                ---
            </span>
        `;

        subsystemListElement.appendChild(row);
    }
}

function updateSubsystemHealth(subsystems) {
    const currentSubsystems = subsystems || {};

    const definitions =
        Array.isArray(CONFIG?.subsystems) &&
        CONFIG.subsystems.length > 0
            ? CONFIG.subsystems
            : FALLBACK_SUBSYSTEMS;

    for (const subsystem of definitions) {
        const badge =
            document.getElementById(
                `subsystem-${subsystem.key}`
            );

        if (!badge) {
            continue;
        }

        const state =
            currentSubsystems[subsystem.key];

        if (!state) {
            badge.textContent = "---";
            badge.className =
                "subsystem-badge";
            continue;
        }

        badge.textContent = state;

        const statusClass =
            getStatusClass(state);

        badge.className =
            "subsystem-badge " +
            statusClass;
    }
}

function updateAlarms(alarms) {
    alarmListElement.innerHTML = "";

    if (!Array.isArray(alarms) || alarms.length === 0) {
        const noAlarms =
            document.createElement("div");

        noAlarms.className = "no-alarms";
        noAlarms.textContent =
            "No active alarms";

        alarmListElement.appendChild(
            noAlarms
        );

        return;
    }

    for (const alarm of alarms) {
        const alarmElement =
            document.createElement("div");

        const alarmClass =
            getStatusClass(alarm.level);

        alarmElement.className =
            "alarm-item " +
            alarmClass;

        alarmElement.textContent =
            alarm.message || "Alarm detected";

        alarmListElement.appendChild(
            alarmElement
        );
    }
}

function clearTelemetryDisplay() {
    document.getElementById("satellite").textContent = "---";
    document.getElementById("battery").textContent = "---";
    document.getElementById("temperature").textContent = "---";
    document.getElementById("signal").textContent = "---";
    document.getElementById("cpu").textContent = "---";

    const statusElement =
        document.getElementById("status");

    statusElement.textContent = "---";
    statusElement.className = "";

    updateSubsystemHealth({});
    updateAlarms([]);
}

async function loadTelemetry() {
    try {
        clearError();

        const config =
            await loadConfig();

        const response =
            await fetch(
                `${config.api_url}/telemetry/latest`
            );

        if (response.status === 404) {
            setConnectionState(true);

            clearTelemetryDisplay();

            lastUpdateElement.textContent =
                "No telemetry yet";

            return;
        }

        if (!response.ok) {
            throw new Error(
                `Telemetry request failed with HTTP ${response.status}`
            );
        }

        const telemetry =
            await response.json();

        setConnectionState(true);

        document.getElementById("satellite")
            .textContent =
            telemetry.satellite_id || "---";

        document.getElementById("battery")
            .textContent =
            telemetry.battery !== undefined
                ? `${telemetry.battery} %`
                : "---";

        document.getElementById("temperature")
            .textContent =
            telemetry.temperature !== undefined
                ? `${telemetry.temperature} °C`
                : "---";

        document.getElementById("signal")
            .textContent =
            telemetry.signal_strength !== undefined
                ? `${telemetry.signal_strength} %`
                : "---";

        document.getElementById("cpu")
            .textContent =
            telemetry.cpu_load !== undefined
                ? `${telemetry.cpu_load} %`
                : "---";

        const statusElement =
            document.getElementById("status");

        const status =
            telemetry.status || "---";

        statusElement.textContent =
            status;

        statusElement.className =
            getStatusClass(status);

        updateSubsystemHealth(
            telemetry.subsystems
        );

        updateAlarms(
            telemetry.alarms
        );

        if (telemetry.timestamp) {
            lastUpdateElement.textContent =
                new Date(
                    telemetry.timestamp
                ).toLocaleTimeString();
        } else {
            lastUpdateElement.textContent =
                new Date().toLocaleTimeString();
        }

    } catch (error) {
        console.error(
            "Failed to load telemetry:",
            error
        );

        setConnectionState(false);

        showError(
            "Unable to connect to Mission Control backend."
        );
    }
}

async function init() {
    try {
        const config =
            await loadConfig();

        buildSubsystemRows(
            config.subsystems
        );

        await loadTelemetry();

        const updateRate =
            Number(config.update_rate);

        const refreshInterval =
            Number.isFinite(updateRate) &&
            updateRate > 0
                ? updateRate * 1000
                : 5000;

        setInterval(
            loadTelemetry,
            refreshInterval
        );

        document
            .getElementById("openDashboard")
            .addEventListener(
                "click",
                () => {
                    chrome.tabs.create({
                        url: config.dashboard_url
                    });
                }
            );

        document
            .getElementById("refreshButton")
            .addEventListener(
                "click",
                () => {
                    loadTelemetry();
                }
            );

    } catch (error) {
        console.error(
            "Failed to initialize Mission Control extension:",
            error
        );

        setConnectionState(false);

        showError(
            "Unable to load backend configuration."
        );
    }
}

init();