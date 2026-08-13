// MCGS dashboard.js — build 2026-08-13-polish-v13
// Phase G polish (toolbar, theme, export, shortcuts).
// Sparklines still refresh inside pushChartHistory.
// If DevTools → Sources does not show this line, the browser has a cached/old file.
// =========================
// Backend Bootstrap
// =========================
// This is the ONLY hardcoded value in this file. A static HTML/JS page
// has no way to read the backend's .env directly — it has to know where
// to ask. Everything else (WebSocket URL, REST API origin, project name,
// update rate, satellite name, subsystem list) is fetched from the
// backend's centralized configuration below.
const BACKEND_ORIGIN = "http://127.0.0.1:8000";
// =========================
// Fleet state
// =========================
// One entry per satellite, keyed by satellite_id, created the first time
// that satellite's telemetry is seen (via the initial history bootstrap
// or a live WebSocket message). This is the single source of truth the
// fleet cards, the map markers/trails, and the selector-driven charts all
// read from — no satellite ID is hardcoded anywhere in this file.
const fleet = new Map();
// Which satellite the "Live Telemetry" panel, the Subsystem Health panel,
// and the three charts are currently scoped to. Fleet cards and the map
// always show every satellite; this is the one thing that's
// single-satellite-at-a-time.
let selectedSatelliteId = null;

// WebSocket connection state for the mission header Connection field.
// Updated only from socket.onopen / socket.onclose / socket.onerror —
// never invented independently of the real socket lifecycle.
let wsConnected = false;

// Set once, in initDashboard(), from GET /config -- the Command Uplink
// functions below are top-level (called from button click handlers and
// showSatellite(), not nested inside initDashboard() like
// bootstrapFleet()/bootstrapEvents()/refreshOrbitTracks() are), so they
// can't close over initDashboard()'s local `config` the way those do.
let dashboardConfig = null;

// Phase C #11 — Historical Replay
// When not "live", chart/sparkline/gauge detail for the selected satellite
// is driven by GET /telemetry/history instead of the live WebSocket stream.
// Fleet cards + map still follow live packets so situational awareness is kept.
let replayMode = "live"; // live | 1h | 24h | today | custom
let replayActive = false;
// Phase C #12 — scrub buffer for the loaded history window (oldest → newest).
let replayRecords = [];
let replayIndex = 0;
let timeSliderPlayTimer = null;

// Connection monitor (client-side, honest metrics only)
let connPacketsRx = 0;
let connGapEstimate = 0;
let connLastPacketMs = null;
let connExpectedIntervalSec = null; // from /config update_rate
let connRestOk = null;
let connRestLatencyMs = null;


// Assigned by order of first appearance, not by satellite ID, so this
// file never hardcodes which satellite gets which color.
const SATELLITE_COLORS = ["#00E5FF", "#FFC107", "#E040FB"];
const DEFAULT_SATELLITE_COLOR = "#9E9E9E";
function getSatelliteColor(index) {
    return SATELLITE_COLORS[index] ?? DEFAULT_SATELLITE_COLOR;
}
function statusClass(status) {
    if (status === "Nominal" || status === "NOMINAL" || status === "nominal") return "nominal";
    if (status === "Warning" || status === "WARNING" || status === "warning") return "warning";
    if (status === "Critical" || status === "CRITICAL" || status === "critical") return "critical";
    return "unknown";
}
function normalizeStatus(status) {
    if (typeof status !== "string") {
        return null;
    }
    const normalized = status.trim().toLowerCase();
    if (normalized === "nominal") {
        return "Nominal";
    }
    if (normalized === "warning") {
        return "Warning";
    }
    if (normalized === "critical") {
        return "Critical";
    }
    return null;
}
function statusText(status) {
    const normalized = normalizeStatus(status);
    if (normalized === "Nominal") {
        return "NOMINAL";
    }
    if (normalized === "Warning") {
        return "WARNING";
    }
    if (normalized === "Critical") {
        return "CRITICAL";
    }
    return "UNKNOWN";
}
function metricHealthFromTelemetry(telemetry, metric) {
    if (!telemetry) {
        return null;
    }
    const subsystems = telemetry.subsystems || {};
    const subsystemForMetric = {
        battery: "power",
        temperature: "thermal",
        signal: "communications",
    };
    const subsystem = subsystemForMetric[metric];
    if (subsystem && subsystems[subsystem]) {
        return normalizeStatus(subsystems[subsystem]);
    }
    if (metric === "cpu") {
        const cpuAlarm = (telemetry.alarms || []).find((alarm) => alarm.rule === "cpu_warning");
        if (cpuAlarm && cpuAlarm.level) {
            return normalizeStatus(cpuAlarm.level);
        }
        // No CPU alarm → healthy (gauges previously showed "---" when null).
        return "nominal";
    }
    const alarmList = telemetry.alarms || [];
    const matching = alarmList.filter((alarm) => {
        if (subsystem && alarm.subsystem) {
            return alarm.subsystem === subsystem;
        }
        return false;
    });
    if (matching.length === 0) {
        return null;
    }
    return normalizeStatus(highestAlarmLevel(matching));
}
function renderStatusIndicator(status) {
    const normalized = normalizeStatus(status);
    const visible = normalized ? statusText(normalized) : "UNKNOWN";
    const cssClass = normalized ? statusClass(normalized) : "unknown";
    return `<span class="status-indicator ${cssClass}"><span class="status-dot"></span><span class="status-text">${visible}</span></span>`;
}
function renderMetricCell(value, status) {
    const statusIndicator = renderStatusIndicator(status);
    return `<span class="detail-value-cell"><span class="telemetry-value">${value}</span>${statusIndicator}</span>`;
}
function formatLocation(latitude, longitude) {
    const latHemisphere = latitude >= 0 ? "N" : "S";
    const lonHemisphere = longitude >= 0 ? "E" : "W";
    return (
        Math.abs(latitude).toFixed(2) + "°" + latHemisphere +
        ", " +
        Math.abs(longitude).toFixed(2) + "°" + lonHemisphere
    );
}
// =========================
// Antimeridian handling
// =========================
// Leaflet draws a naive straight line between consecutive points, which
// crosses the map the "wrong way" around the globe whenever a ground
// track crosses the +/-180° longitude line. Splitting into separate
// segments wherever the longitude jump exceeds 180° avoids that visual
// artifact. Shared by both the live telemetry trail and the predicted
// orbit overlay so the two never diverge in how they handle the seam.
function splitAtAntimeridian(latLngs) {
    if (latLngs.length === 0) {
        return [];
    }
    const segments = [];
    let currentSegment = [latLngs[0]];
    for (let i = 1; i < latLngs.length; i++) {
        const previousLongitude = latLngs[i - 1][1];
        const currentLongitude = latLngs[i][1];
        if (Math.abs(currentLongitude - previousLongitude) > 180) {
            segments.push(currentSegment);
            currentSegment = [];
        }
        currentSegment.push(latLngs[i]);
    }
    segments.push(currentSegment);
    return segments;
}
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


// =========================
// Tracking Mode
// =========================
// Tracking now follows the SELECTED satellite (see the selector below),
// not "whichever satellite's packet just arrived" — with three satellites
// interleaving, panning to whoever last reported would jump the map
// between three different points on Earth every few seconds.
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
// Satellite Selector
// =========================
const satelliteSelector = document.getElementById("satelliteSelector");
satelliteSelector.addEventListener("change", () => {
    showSatellite(satelliteSelector.value);
});
function showSatellite(satelliteId) {
    const entry = fleet.get(satelliteId);
    if (!entry) {
        return;
    }
    selectedSatelliteId = satelliteId;
    satelliteSelector.value = satelliteId;
    // Phase E — selected state on fleet cards
    for (const e of fleet.values()) {
        if (e.card) {
            e.card.classList.toggle(
                "status-card-selected",
                e.card.dataset.satelliteId === satelliteId
            );
        }
    }
    refreshCommandUplinkPanel(satelliteId);
    if (replayActive && replayMode !== "live") {
        loadHistoricalReplay(replayMode);
        updateMissionHeader();
        return;
    }
    if (entry.latest) {
        updateDetailPanel(entry.latest);
        updateSubsystemHealthPanel(entry.latest);
    }
    try {
        renderChartsFor(entry);
    } catch (err) {
        console.error("renderChartsFor:", err);
    }
    try {
        renderSparklinesFor(entry);
    } catch (err) {
        console.error("renderSparklinesFor:", err);
    }
    updateMissionHeader();
}

// =========================
// Mission Header (dynamic)
// =========================
// Driven only by existing state: selectedSatelliteId, entry.latest.timestamp,
// and the real WebSocket open/close lifecycle (wsConnected). Orbit is static
// LEO — the application has no orbital-regime field today.

function formatPacketTimeUtc(timestamp) {
    if (!timestamp) {
        return "---";
    }
    const d = new Date(timestamp);
    if (Number.isNaN(d.getTime())) {
        return "---";
    }
    // HH:MM:SS UTC — matches the compact aerospace header style
    return d.toISOString().slice(11, 19) + " UTC";
}

function updateMissionHeader() {
    const missionEl = document.getElementById("mhMission");
    const sourceEl = document.getElementById("mhSource");
    const lastPacketEl = document.getElementById("mhLastPacket");
    const connectionEl = document.getElementById("mhConnection");
    if (!missionEl || !sourceEl || !lastPacketEl || !connectionEl) {
        return;
    }

    missionEl.textContent = selectedSatelliteId || "---";

    if (wsConnected) {
        sourceEl.textContent = "Live";
        sourceEl.className = "mh-value live";
        connectionEl.textContent = "ONLINE";
        connectionEl.className = "mh-value online";
    } else {
        sourceEl.textContent = "---";
        sourceEl.className = "mh-value offline";
        connectionEl.textContent = "OFFLINE";
        connectionEl.className = "mh-value offline";
    }

    let lastTs = null;
    if (selectedSatelliteId && fleet.has(selectedSatelliteId)) {
        const entry = fleet.get(selectedSatelliteId);
        if (entry && entry.latest && entry.latest.timestamp) {
            lastTs = entry.latest.timestamp;
        }
    }
    lastPacketEl.textContent = formatPacketTimeUtc(lastTs);
    if (wsConnected && lastTs) {
        lastPacketEl.classList.remove("packet-tick");
        void lastPacketEl.offsetWidth;
        lastPacketEl.classList.add("packet-tick");
    }
}

// =========================
// Mission Clock
// =========================
// Compact aerospace instrumentation strip:
//   UTC            — browser clock, forced to UTC (not local TZ)
//   Mission Elapsed — T+ from dashboard session start (no backend
//                     mission-start field exists today)
//   Update Rate    --- GET /config's real update_rate (seconds between
//                     simulated telemetry samples); set once in
//                     initDashboard() below, not on this 1 Hz loop
//   Frame Rate     — measured browser paint rate via rAF (honest FPS,
//                     not a hard-coded number)
//
// One 1 Hz interval drives UTC + elapsed. One lightweight rAF loop
// counts frames. Neither touches WebSocket/telemetry paths.

const missionStartMs = Date.now();

function formatUtcNow() {
    const d = new Date();
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    const ss = String(d.getUTCSeconds()).padStart(2, "0");
    return hh + ":" + mm + ":" + ss + " UTC";
}

function formatMissionElapsed(elapsedMs) {
    const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
    const hh = String(Math.floor(totalSec / 3600)).padStart(2, "0");
    const mm = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
    const ss = String(totalSec % 60).padStart(2, "0");
    return "T+" + hh + ":" + mm + ":" + ss;
}

function tickMissionClock() {
    const utcEl = document.getElementById("mcUtc");
    const elapsedEl = document.getElementById("mcElapsed");
    if (utcEl) {
        utcEl.textContent = formatUtcNow();
    }
    if (elapsedEl) {
        elapsedEl.textContent = formatMissionElapsed(Date.now() - missionStartMs);
    }
}

// 1 Hz wall-clock / elapsed update — single shared interval for both.
setInterval(tickMissionClock, 1000);
tickMissionClock();

// Honest browser frame-rate sample (paint rate), not a fabricated value.
(function startFrameRateMonitor() {
    let frames = 0;
    let windowStart = performance.now();
    function sample(now) {
        frames += 1;
        const dt = now - windowStart;
        if (dt >= 1000) {
            const fps = Math.round((frames * 1000) / dt);
            const el = document.getElementById("mcFrameRate");
            if (el) {
                el.textContent = fps + " FPS";
            }
            frames = 0;
            windowStart = now;
        }
        requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
})();

// =========================
// Create a reusable chart
// =========================
// Display-only threshold guides for Telemetry Plots (Phase C #10).
// These are operator visual references on the chart — they do NOT replace
// backend alarm evaluation (backend/app/core/alarms.py).
const CHART_THRESHOLDS = {
    battery: {
        // Low battery: amber band below 30%, red line at 15%
        warningMax: 30,
        criticalMax: 15,
        ySuggestedMin: 0,
        ySuggestedMax: 100,
        unit: "%",
    },
    temperature: {
        // Thermal comfort band ~0–40°C; warning outside soft range
        warningMin: 5,
        warningMax: 40,
        criticalMin: 0,
        criticalMax: 50,
        ySuggestedMin: 0,
        ySuggestedMax: 50,
        unit: "°C",
    },
    cpu: {
        // High CPU load
        warningMin: 70,
        criticalMin: 90,
        ySuggestedMin: 0,
        ySuggestedMax: 100,
        unit: "%",
    },
};

function buildChartAnnotations(metricKey) {
    const t = CHART_THRESHOLDS[metricKey];
    if (!t) {
        return {};
    }
    const ann = {};
    // Warning band (amber, translucent)
    if (metricKey === "battery" && t.warningMax != null) {
        ann.warningBand = {
            type: "box",
            yMin: 0,
            yMax: t.warningMax,
            backgroundColor: "rgba(240, 168, 60, 0.08)",
            borderWidth: 0,
        };
        ann.warningLine = {
            type: "line",
            yMin: t.warningMax,
            yMax: t.warningMax,
            borderColor: "rgba(240, 168, 60, 0.85)",
            borderWidth: 1,
            borderDash: [6, 4],
            label: {
                display: true,
                content: "WARN " + t.warningMax + t.unit,
                position: "end",
                backgroundColor: "rgba(17, 25, 46, 0.85)",
                color: "#f0a83c",
                font: { size: 9, weight: "700" },
            },
        };
    }
    if (metricKey === "battery" && t.criticalMax != null) {
        ann.criticalLine = {
            type: "line",
            yMin: t.criticalMax,
            yMax: t.criticalMax,
            borderColor: "rgba(240, 72, 61, 0.9)",
            borderWidth: 1,
            borderDash: [4, 3],
            label: {
                display: true,
                content: "CRIT " + t.criticalMax + t.unit,
                position: "start",
                backgroundColor: "rgba(17, 25, 46, 0.85)",
                color: "#f0483d",
                font: { size: 9, weight: "700" },
            },
        };
    }
    if (metricKey === "temperature") {
        if (t.warningMin != null && t.warningMax != null) {
            ann.nominalBand = {
                type: "box",
                yMin: t.warningMin,
                yMax: t.warningMax,
                backgroundColor: "rgba(63, 174, 106, 0.06)",
                borderWidth: 0,
            };
        }
        if (t.criticalMax != null) {
            ann.hotLine = {
                type: "line",
                yMin: t.criticalMax,
                yMax: t.criticalMax,
                borderColor: "rgba(240, 72, 61, 0.9)",
                borderWidth: 1,
                borderDash: [4, 3],
                label: {
                    display: true,
                    content: "HOT " + t.criticalMax + t.unit,
                    position: "end",
                    backgroundColor: "rgba(17, 25, 46, 0.85)",
                    color: "#f0483d",
                    font: { size: 9, weight: "700" },
                },
            };
        }
        if (t.warningMax != null) {
            ann.warmLine = {
                type: "line",
                yMin: t.warningMax,
                yMax: t.warningMax,
                borderColor: "rgba(240, 168, 60, 0.85)",
                borderWidth: 1,
                borderDash: [6, 4],
                label: {
                    display: true,
                    content: "WARM " + t.warningMax + t.unit,
                    position: "start",
                    backgroundColor: "rgba(17, 25, 46, 0.85)",
                    color: "#f0a83c",
                    font: { size: 9, weight: "700" },
                },
            };
        }
    }
    if (metricKey === "cpu") {
        if (t.warningMin != null) {
            ann.warningBand = {
                type: "box",
                yMin: t.warningMin,
                yMax: t.criticalMin != null ? t.criticalMin : 100,
                backgroundColor: "rgba(240, 168, 60, 0.08)",
                borderWidth: 0,
            };
            ann.warningLine = {
                type: "line",
                yMin: t.warningMin,
                yMax: t.warningMin,
                borderColor: "rgba(240, 168, 60, 0.85)",
                borderWidth: 1,
                borderDash: [6, 4],
                label: {
                    display: true,
                    content: "WARN " + t.warningMin + t.unit,
                    position: "end",
                    backgroundColor: "rgba(17, 25, 46, 0.85)",
                    color: "#f0a83c",
                    font: { size: 9, weight: "700" },
                },
            };
        }
        if (t.criticalMin != null) {
            ann.criticalBand = {
                type: "box",
                yMin: t.criticalMin,
                yMax: 100,
                backgroundColor: "rgba(240, 72, 61, 0.08)",
                borderWidth: 0,
            };
            ann.criticalLine = {
                type: "line",
                yMin: t.criticalMin,
                yMax: t.criticalMin,
                borderColor: "rgba(240, 72, 61, 0.9)",
                borderWidth: 1,
                borderDash: [4, 3],
                label: {
                    display: true,
                    content: "CRIT " + t.criticalMin + t.unit,
                    position: "start",
                    backgroundColor: "rgba(17, 25, 46, 0.85)",
                    color: "#f0483d",
                    font: { size: 9, weight: "700" },
                },
            };
        }
    }
    return ann;
}

function createTelemetryChart(canvasId, label, color, metricKey) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) {
        console.error("Chart canvas not found:", canvasId);
        return null;
    }
    if (typeof Chart === "undefined") {
        console.error("Chart.js global is not available");
        return null;
    }
    const parent = canvas.parentElement;
    const parentRect = parent ? parent.getBoundingClientRect() : null;
    if (parent && parentRect && (parentRect.width < 2 || parentRect.height < 2)) {
        console.warn("[MCGS charts] parent had near-zero size at init:", canvasId);
    }
    const thresholds = CHART_THRESHOLDS[metricKey] || {};
    const annotations = buildChartAnnotations(metricKey);
    const hasZoomPlugin = !!(Chart.registry && Chart.registry.plugins && Chart.registry.plugins.get("zoom"));
    const hasAnnotationPlugin = !!(typeof annotations === "object");

    return new Chart(canvas, {
        type: "line",
        data: {
            labels: [],
            datasets: [
                {
                    label: label,
                    data: [],
                    borderColor: color,
                    backgroundColor: "transparent",
                    borderWidth: 2,
                    tension: 0.3,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    pointHitRadius: 8,
                    pointHoverBackgroundColor: color,
                    pointHoverBorderColor: "#e6ebf3",
                    pointHoverBorderWidth: 1,
                    fill: false,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 280, easing: "easeOutQuad" },
            interaction: {
                mode: "index",
                intersect: false,
            },
            scales: {
                x: {
                    ticks: {
                        color: "#7c8aab",
                        maxRotation: 0,
                        autoSkip: true,
                        maxTicksLimit: 6,
                        font: { size: 10 },
                    },
                    grid: { color: "rgba(38, 50, 82, 0.85)" },
                },
                y: {
                    suggestedMin: thresholds.ySuggestedMin,
                    suggestedMax: thresholds.ySuggestedMax,
                    ticks: {
                        color: "#7c8aab",
                        font: { size: 10 },
                    },
                    grid: { color: "rgba(38, 50, 82, 0.85)" },
                },
            },
            plugins: {
                legend: {
                    display: true,
                    labels: {
                        color: "#e6ebf3",
                        boxWidth: 12,
                        font: { size: 11 },
                    },
                },
                tooltip: {
                    enabled: true,
                    backgroundColor: "rgba(10, 15, 30, 0.94)",
                    titleColor: "#2dd4ee",
                    bodyColor: "#e6ebf3",
                    borderColor: "#263252",
                    borderWidth: 1,
                    padding: 10,
                    displayColors: true,
                    callbacks: {
                        label: function (ctx) {
                            const unit = thresholds.unit || "";
                            const y = ctx.parsed.y;
                            if (y == null || Number.isNaN(y)) {
                                return ctx.dataset.label + ": —";
                            }
                            return ctx.dataset.label + ": " + Number(y).toFixed(1) + unit;
                        },
                    },
                },
                // Threshold lines + warning bands (chartjs-plugin-annotation)
                annotation: {
                    annotations: annotations,
                },
                // Zoom / pan (chartjs-plugin-zoom). Wheel = zoom, drag = pan.
                zoom: {
                    limits: {
                        y: { min: "original", max: "original" },
                    },
                    pan: {
                        enabled: true,
                        mode: "x",
                        modifierKey: null,
                    },
                    zoom: {
                        wheel: { enabled: true, speed: 0.08 },
                        pinch: { enabled: true },
                        mode: "x",
                        drag: {
                            enabled: true,
                            backgroundColor: "rgba(45, 212, 238, 0.08)",
                            borderColor: "rgba(45, 212, 238, 0.45)",
                            borderWidth: 1,
                        },
                    },
                },
            },
            onClick: function (evt, elements, chart) {
                // Double-click handled via canvas listener below
            },
        },
    });
}

function wireChartResetZoom(chart, canvasId) {
    if (!chart) return;
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    // Double-click chart → reset zoom/pan
    canvas.addEventListener("dblclick", function () {
        if (chart && typeof chart.resetZoom === "function") {
            chart.resetZoom();
        }
    });
    // Optional explicit button next to the canvas
    const btnId = canvasId + "ResetZoom";
    let btn = document.getElementById(btnId);
    if (!btn) {
        const block = canvas.closest(".chart-block");
        if (block) {
            btn = document.createElement("button");
            btn.type = "button";
            btn.id = btnId;
            btn.className = "chart-reset-zoom";
            btn.textContent = "Reset zoom";
            btn.title = "Reset zoom/pan (or double-click chart)";
            block.appendChild(btn);
        }
    }
    if (btn) {
        btn.onclick = function () {
            if (chart && typeof chart.resetZoom === "function") {
                chart.resetZoom();
            }
        };
    }
}
// =========================
// Create the charts
// =========================
// Each chart shows exactly one line: the currently-selected satellite's
// data. Every satellite's own history keeps accumulating in the fleet Map
// even while not displayed (see pushChartHistory/renderChartsFor below),
// so switching the selector back to a previously-viewed satellite shows
// its real trend, not a reset chart.
// Chart instances are intentionally NOT created at global script-load time.
// At that moment CSS Grid may not have assigned non-zero boxes to
// .chart-container yet; Chart.js then binds to a 0x0 canvas and stays blank.
// initializeTelemetryCharts() runs after layout is ready (from initDashboard).
let batteryChart = null;
let temperatureChart = null;
let cpuChart = null;
let telemetryChartsReady = false;

function destroyTelemetryChart(chart) {
    if (chart && typeof chart.destroy === "function") {
        try {
            chart.destroy();
        } catch (err) {
            console.warn("[MCGS charts] destroy failed:", err);
        }
    }
}

function initializeTelemetryCharts() {
    if (typeof Chart === "undefined") {
        console.error("[MCGS charts] Chart.js not loaded — plots disabled");
        return false;
    }
    // Idempotent: destroy any previous instances before (re)creating.
    destroyTelemetryChart(batteryChart);
    destroyTelemetryChart(temperatureChart);
    destroyTelemetryChart(cpuChart);
    batteryChart = null;
    temperatureChart = null;
    cpuChart = null;

    batteryChart = createTelemetryChart(
        "batteryChart",
        "Battery (%)",
        "#4CAF50",
        "battery"
    );
    temperatureChart = createTelemetryChart(
        "temperatureChart",
        "Temperature (°C)",
        "#FF9800",
        "temperature"
    );
    cpuChart = createTelemetryChart(
        "cpuChart",
        "CPU (%)",
        "#03A9F4",
        "cpu"
    );

    wireChartResetZoom(batteryChart, "batteryChart");
    wireChartResetZoom(temperatureChart, "temperatureChart");
    wireChartResetZoom(cpuChart, "cpuChart");

    telemetryChartsReady = !!(batteryChart && temperatureChart && cpuChart);
    console.info("[MCGS charts] initializeTelemetryCharts done", {
        ready: telemetryChartsReady,
        battery: !!batteryChart,
        temperature: !!temperatureChart,
        cpu: !!cpuChart,
    });
    return telemetryChartsReady;
}

function refreshTelemetryChartSizes() {
    for (const chart of [batteryChart, temperatureChart, cpuChart]) {
        if (chart && typeof chart.resize === "function") {
            try {
                chart.resize();
            } catch (err) {
                console.warn("[MCGS charts] resize failed:", err);
            }
        }
    }
}

function scheduleTelemetryChartInit() {
    // Double rAF: wait until the browser has applied CSS and completed layout.
    requestAnimationFrame(function () {
        requestAnimationFrame(function () {
            initializeTelemetryCharts();
            refreshTelemetryChartSizes();
            // If a satellite is already selected (bootstrap raced ahead), repaint.
            if (selectedSatelliteId && fleet.has(selectedSatelliteId)) {
                const entry = fleet.get(selectedSatelliteId);
                renderChartsFor(entry);
                renderSparklinesFor(entry);
            }
        });
    });
}

window.addEventListener("resize", refreshTelemetryChartSizes);

function pushChartHistory(entry, telemetry) {
    if (!entry || !telemetry) {
        return;
    }
    const label = new Date(telemetry.timestamp).toLocaleTimeString();
    const fields = [
        ["batteryHistory", telemetry.battery],
        ["temperatureHistory", telemetry.temperature],
        ["signalHistory", telemetry.signal_strength],
        ["cpuHistory", telemetry.cpu_load],
    ];
    for (const [key, value] of fields) {
        if (!entry[key]) {
            entry[key] = { labels: [], values: [] };
        }
        entry[key].labels.push(label);
        entry[key].values.push(value);
        // Keep only the latest 20 samples, per satellite.
        if (entry[key].labels.length > 20) {
            entry[key].labels.shift();
            entry[key].values.shift();
        }
    }
    // Phase C sparklines: update immediately when history grows for the
    // selected satellite so trends cannot lag or stick at "—".
    if (telemetry.satellite_id === selectedSatelliteId) {
        try {
            refreshSparklineStrip(entry, telemetry);
        } catch (err) {
            console.error("[MCGS] refreshSparklineStrip failed:", err);
        }
    }
}

function refreshSparklineStrip(entry, telemetry) {
    const write = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };
    if (telemetry) {
        write("batteryMetricValue", Number(telemetry.battery).toFixed(1) + "%");
        write("temperatureMetricValue", Number(telemetry.temperature).toFixed(1) + "°C");
        write("signalMetricValue", Number(telemetry.signal_strength).toFixed(1) + "%");
        write("cpuMetricValue", Number(telemetry.cpu_load).toFixed(1) + "%");
    }
    if (!entry) return;
    renderSparkline(document.getElementById("batterySparkline"), entry.batteryHistory && entry.batteryHistory.values);
    renderSparkline(document.getElementById("temperatureSparkline"), entry.temperatureHistory && entry.temperatureHistory.values);
    renderSparkline(document.getElementById("signalSparkline"), entry.signalHistory && entry.signalHistory.values);
    renderSparkline(document.getElementById("cpuSparkline"), entry.cpuHistory && entry.cpuHistory.values);
}
function renderChartsFor(entry) {
    if (!entry) {
        return;
    }
    // Lazy safety net: if init has not completed yet, create charts now.
    if (!telemetryChartsReady || !batteryChart) {
        initializeTelemetryCharts();
    }
    // Data only — never resize() on the telemetry hot path.
    try {
        if (batteryChart && entry.batteryHistory) {
            batteryChart.data.labels = entry.batteryHistory.labels.slice();
            batteryChart.data.datasets[0].data = entry.batteryHistory.values.slice();
            batteryChart.update("none");
        }
        if (temperatureChart && entry.temperatureHistory) {
            temperatureChart.data.labels = entry.temperatureHistory.labels.slice();
            temperatureChart.data.datasets[0].data = entry.temperatureHistory.values.slice();
            temperatureChart.update("none");
        }
        if (cpuChart && entry.cpuHistory) {
            cpuChart.data.labels = entry.cpuHistory.labels.slice();
            cpuChart.data.datasets[0].data = entry.cpuHistory.values.slice();
            cpuChart.update("none");
        }
    } catch (err) {
        console.error("renderChartsFor failed:", err);
    }
}
// =========================
// Compact telemetry sparklines (Phase C, item 9)
// =========================
// Reuses the SAME per-satellite history already maintained above for the
// full charts (batteryHistory/temperatureHistory/cpuHistory) — signalHistory
// is the one addition, since signal strength wasn't tracked historically
// before (it has no full chart). Populated by the same pushChartHistory()
// call already made for every telemetry sample, live or bootstrapped, so
// no second history system, extra fetch, or extra timer is introduced.
const SPARKLINE_WIDTH = 120;
const SPARKLINE_HEIGHT = 28;
const SPARKLINE_MAX_SAMPLES = 20;
const SPARKLINE_METRICS = [
    { historyKey: "batteryHistory", svgId: "batterySparkline", valueId: "batteryMetricValue", decimals: 1, unit: "%" },
    { historyKey: "temperatureHistory", svgId: "temperatureSparkline", valueId: "temperatureMetricValue", decimals: 1, unit: "°C" },
    { historyKey: "signalHistory", svgId: "signalSparkline", valueId: "signalMetricValue", decimals: 1, unit: "%" },
    { historyKey: "cpuHistory", svgId: "cpuSparkline", valueId: "cpuMetricValue", decimals: 1, unit: "%" },
];
// Normalizes up to SPARKLINE_MAX_SAMPLES values into an SVG polyline
// "points" string plus the last point's coordinates (for the endpoint
// dot). Returns null for an empty/missing history — callers clear the
// SVG in that case rather than drawing anything. A single sample, or all
// identical samples, both render as a flat centered line rather than
// throwing or producing NaN coordinates.
function buildSparklinePoints(values, width, height) {
    if (!Array.isArray(values) || values.length === 0) {
        return null;
    }
    if (values.length === 1) {
        const y = height / 2;
        return { points: `0,${y} ${width},${y}`, lastX: width, lastY: y };
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min;
    const stepX = width / (values.length - 1);
    const coords = values.map((value, index) => {
        const x = index * stepX;
        const normalized = span === 0 ? 0.5 : (value - min) / span;
        const y = height - normalized * height;
        return [x, y];
    });
    const points = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    const [lastX, lastY] = coords[coords.length - 1];
    return { points, lastX, lastY };
}
// Redraws one sparkline `<svg>` from scratch — cheap enough to call on
// every telemetry packet for the (single) selected satellite, no
// different in cost from the existing renderChartsFor() call it sits
// next to. Non-finite/missing samples are filtered out defensively so a
// bad value can never reach buildSparklinePoints() as NaN.
function sparklineColorFor(svgEl) {
    const id = svgEl && svgEl.id ? svgEl.id : "";
    if (id === "batterySparkline") return "#3dd68c";
    if (id === "temperatureSparkline") return "#f0a83c";
    if (id === "signalSparkline") return "#00e5ff";
    if (id === "cpuSparkline") return "#00e5ff";
    return "#e6ebf3";
}

function renderSparkline(svgEl, rawValues) {
    if (!svgEl) {
        return;
    }
    while (svgEl.firstChild) {
        svgEl.removeChild(svgEl.firstChild);
    }
    // Coerce numeric strings so bootstrap/JSON edge cases still plot.
    const values = (Array.isArray(rawValues) ? rawValues : [])
        .map((value) => (typeof value === "number" ? value : Number(value)))
        .filter((value) => Number.isFinite(value))
        .slice(-SPARKLINE_MAX_SAMPLES);
    const built = buildSparklinePoints(values, SPARKLINE_WIDTH, SPARKLINE_HEIGHT);
    if (!built) {
        return;
    }
    const ns = "http://www.w3.org/2000/svg";
    const color = sparklineColorFor(svgEl);
    const polyline = document.createElementNS(ns, "polyline");
    polyline.setAttribute("points", built.points);
    polyline.setAttribute("class", "sparkline-line");
    polyline.setAttribute("fill", "none");
    polyline.setAttribute("stroke", color);
    polyline.setAttribute("stroke-width", "1.75");
    polyline.setAttribute("stroke-linejoin", "round");
    polyline.setAttribute("stroke-linecap", "round");
    svgEl.appendChild(polyline);
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", built.lastX.toFixed(1));
    dot.setAttribute("cy", built.lastY.toFixed(1));
    dot.setAttribute("r", "2.2");
    dot.setAttribute("class", "sparkline-dot");
    dot.setAttribute("fill", color);
    dot.setAttribute("stroke", "none");
    svgEl.appendChild(dot);
}

// Called from updateDashboard / showSatellite, and also from
// updateDetailPanel so sparklines always track the same satellite as gauges.
function renderSparklinesFor(entry) {
    for (const metric of SPARKLINE_METRICS) {
        const history = entry && entry[metric.historyKey]
            ? entry[metric.historyKey]
            : { labels: [], values: [] };
        const values = Array.isArray(history.values) ? history.values : [];
        const svgEl = document.getElementById(metric.svgId);
        const valueEl = document.getElementById(metric.valueId);
        try {
            renderSparkline(svgEl, values);
        } catch (err) {
            console.error("renderSparkline failed:", metric.svgId, err);
        }
        if (!valueEl) {
            console.warn("sparkline value element missing:", metric.valueId);
            continue;
        }
        let last = values.length > 0 ? values[values.length - 1] : null;
        if (typeof last !== "number") {
            last = Number(last);
        }
        valueEl.textContent =
            Number.isFinite(last)
                ? last.toFixed(metric.decimals) + metric.unit
                : "—";
    }
}
// =========================
// Fleet Summary Cards
// =========================
function createFleetCard(satelliteId, color) {
    const card = document.createElement("div");
    card.className = "status-card";
    card.style.borderLeftColor = color;
    card.dataset.satelliteId = satelliteId;
    const mapId = "fleetMiniMap_" + satelliteId.replace(/[^a-zA-Z0-9_-]/g, "_");
    card.innerHTML = `
        <div class="fleet-card-top">
            <h3>${satelliteId}</h3>
            <span class="fleet-status">---</span>
        </div>
        <div class="fleet-card-body">
            <div class="fleet-mini-map" id="${mapId}" aria-hidden="true"></div>
            <div class="fleet-card-meta">
                <div class="fleet-metrics">
                    <span class="fleet-battery">BAT ---</span>
                    <span class="fleet-signal">SIG ---</span>
                    <span class="fleet-cpu">CPU ---</span>
                </div>
                <div class="fleet-location">---</div>
                <div class="fleet-updated">---</div>
            </div>
        </div>
    `;
    card.addEventListener("click", () => showSatellite(satelliteId));
    document.getElementById("fleetSummary").appendChild(card);

    // Mini map (Phase E) — independent Leaflet instance, OSM tiles, no interaction.
    let miniMap = null;
    let miniMarker = null;
    try {
        miniMap = L.map(mapId, {
            zoomControl: false,
            attributionControl: false,
            dragging: false,
            scrollWheelZoom: false,
            doubleClickZoom: false,
            boxZoom: false,
            keyboard: false,
        }).setView([0, 0], 1);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 6,
        }).addTo(miniMap);
        miniMarker = L.circleMarker([0, 0], {
            radius: 5,
            color: color,
            fillColor: color,
            fillOpacity: 0.95,
            weight: 1.5,
        }).addTo(miniMap);
        setTimeout(function () {
            try { miniMap.invalidateSize(false); } catch (e) { /* ignore */ }
        }, 80);
    } catch (err) {
        console.warn("fleet mini-map init failed for", satelliteId, err);
    }
    card._miniMap = miniMap;
    card._miniMarker = miniMarker;
    return card;
}
function updateFleetCard(entry, telemetry) {
    // `telemetry.status` is always the backend's own computed value (the
    // worst of its subsystems — see health_status.worst_status(), called
    // from backend/app/routers/telemetry.py) and never client input, so
    // this file uses it directly rather than recomputing "worst subsystem"
    // itself from `telemetry.subsystems` — the backend is the single
    // source of truth for overall status, this file only displays it.
    const statusEl = entry.card.querySelector(".fleet-status");
    statusEl.innerHTML = renderStatusIndicator(telemetry.status);
    statusEl.className = "fleet-status " + statusClass(telemetry.status);
    const battEl = entry.card.querySelector(".fleet-battery");
    if (battEl && Number.isFinite(telemetry.battery)) {
        battEl.textContent = "BAT " + telemetry.battery.toFixed(1) + "%";
    }
    const sigEl = entry.card.querySelector(".fleet-signal");
    if (sigEl && Number.isFinite(telemetry.signal_strength)) {
        sigEl.textContent = "SIG " + telemetry.signal_strength.toFixed(1) + "%";
    }
    const cpuEl = entry.card.querySelector(".fleet-cpu");
    if (cpuEl && Number.isFinite(telemetry.cpu_load)) {
        cpuEl.textContent = "CPU " + telemetry.cpu_load.toFixed(1) + "%";
    }
    const locEl = entry.card.querySelector(".fleet-location");
    if (locEl) {
        locEl.textContent = formatLocation(telemetry.latitude, telemetry.longitude);
    }
    const updEl = entry.card.querySelector(".fleet-updated");
    if (updEl) {
        updEl.textContent =
            "Updated " + new Date(telemetry.timestamp).toLocaleTimeString();
    }
    // Phase E — mini-map position for this satellite card
    if (
        entry.card &&
        entry.card._miniMarker &&
        Number.isFinite(telemetry.latitude) &&
        Number.isFinite(telemetry.longitude)
    ) {
        const ll = [telemetry.latitude, telemetry.longitude];
        entry.card._miniMarker.setLatLng(ll);
        if (entry.card._miniMap) {
            try {
                entry.card._miniMap.setView(ll, 2, { animate: false });
            } catch (e) {
                /* ignore */
            }
        }
    }
    // Highlight selected satellite card
    if (entry.card) {
        entry.card.classList.toggle(
            "status-card-selected",
            telemetry.satellite_id === selectedSatelliteId
        );
    }
}
// =========================
// Map markers + trails (one per satellite)
// =========================
// circleMarker (not the default pin icon) so each satellite can get a
// distinct, solid color without needing custom marker image assets.
const MAX_TRAIL_POINTS = 120;
const CURRENT_TRACK_POINTS = 28;
function createMapEntities(color) {
    const marker = L.circleMarker([0, 0], {
        radius: 8,
        color: color,
        fillColor: color,
        fillOpacity: 0.9,
        weight: 2,
    })
        .addTo(map)
        .bindPopup("Loading satellite data...");
    // Orbit trail per satellite — kept, since it's a direct, low-cost
    // reuse of logic already needed for the marker (same per-satellite
    // Map, same update call site), not a separate feature to build.
    const trail = L.polyline([], {
        color: color,
        weight: 2,
    }).addTo(map);
        // Future / predicted path from backend GET /orbit/tracks
    // (Skyfield + SGP4 on the ISS (ZARYA) TLE stand-in + fleet phase
    // offsets). Scientifically valid SGP4 propagation of that stand-in
    // TLE — NOT a real SD-CUBESAT orbital element set. UI labels must
    // keep this distinction explicit.
    const predictedTrail = L.polyline([], {
        color: "#f0a83c",
        weight: 2,
        dashArray: "7, 7",
        opacity: 0.75,
        lineCap: "round",
        lineJoin: "round",
    }).addTo(map);
    return { marker, trail, predictedTrail };
}
function updateMapMarker(entry, telemetry) {
    const latLng = [telemetry.latitude, telemetry.longitude];
    entry.marker.setLatLng(latLng);
    entry.marker.setPopupContent(`
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
    entry.trailPoints.push(latLng);
    // Keep only the latest 100 positions, per satellite.
    if (entry.trailPoints.length > 100) {
        entry.trailPoints.shift();
    }
    // Antimeridian handling: split into separate segments wherever the
    // longitude jump exceeds 180°, so Leaflet doesn't draw a line the
    // "wrong way" around the globe across the +/-180° seam.
    entry.trail.setLatLngs(splitAtAntimeridian(entry.trailPoints));
}
// =========================
// Predicted orbit overlay (GET /orbit/tracks)
// =========================
// Backend propagates each fleet member forward from its orbital phase
// offset (see backend/simulator/orbit_propagator.py + fleet.py) using the
// ISS (ZARYA) TLE stand-in (backend/simulator/tle.py). Real SGP4/Skyfield
// math on a stand-in ephemeris — not a CubeSat-specific TLE. Independent
// of selectedSatelliteId so every satellite's simulated future path stays
// visible.
function updatePredictedOrbit(satelliteId, track) {
    const entry = getOrCreateFleetEntry(satelliteId);
    const points = track.map((point) => [point.latitude, point.longitude]);
    entry.predictedTrail.setLatLngs(splitAtAntimeridian(points));
}
// =========================
// Alarm system — display only
// =========================
// Alarms are evaluated entirely on the backend
// (backend/app/core/alarms.py) and arrive as part of every telemetry
// sample, in `telemetry.alarms`. This file never re-implements the
// threshold rules — it only displays whatever the backend already
// decided, in three places: a fleet-wide banner, a per-satellite fleet
// card highlight, and a per-satellite map marker highlight.
const alarmBanner = document.getElementById("alarmBanner");
// Highest severity present in an alarm list, or null if it's empty/absent.
// Critical always outranks Warning; these are the only two levels the
// backend currently sends. Defensive against `alarms` being missing
// entirely — GET /telemetry/history and GET /telemetry don't populate it
// (see backend/app/schemas/telemetry.py), so a bootstrap-replayed sample
// may not have it.
function highestAlarmLevel(alarms) {
    if (!alarms || alarms.length === 0) {
        return null;
    }
    if (alarms.some((alarm) => alarm.level === "Critical")) {
        return "Critical";
    }
    if (alarms.some((alarm) => alarm.level === "Warning")) {
        return "Warning";
    }
    return null;
}
// Fleet card border + map marker color, driven by this satellite's own
// current alarm severity. Reverts to the satellite's normal color/border
// the moment its alarms clear — this is level-triggered (re-evaluated
// every packet), unlike the Mission Timeline entries below, which are
// edge-triggered (logged once per new alarm, not on every packet it's
// still active).
function updateAlarmVisuals(entry, telemetry) {
    const level = highestAlarmLevel(telemetry.alarms);
    entry.card.classList.remove("alarm-flash");
    if (level === "Critical") {
        entry.card.style.borderLeftColor = "#F44336";
        entry.card.classList.add("alarm-flash");
        entry.marker.setStyle({ color: "#F44336", fillColor: "#F44336" });
    } else if (level === "Warning") {
        entry.card.style.borderLeftColor = "#FFC107";
        entry.marker.setStyle({ color: "#FFC107", fillColor: "#FFC107" });
    } else {
        entry.card.style.borderLeftColor = entry.color;
        entry.marker.setStyle({ color: entry.color, fillColor: entry.color });
    }
    entry.activeAlarms = telemetry.alarms || [];
}
// Fleet-wide banner: shows the single worst active alarm anywhere in the
// fleet (Critical beats Warning), or hides itself when nothing is active.
function updateAlarmBanner() {
    let worstLevel = null;
    let worstAlarm = null;
    const allAlarms = [];

    for (const [satelliteId, entry] of fleet.entries()) {
        const alarms = entry.activeAlarms || [];
        for (const alarm of alarms) {
            allAlarms.push({
                satellite_id: satelliteId,
                level: alarm.level,
                message: alarm.message || alarm.rule || "Alarm",
                rule: alarm.rule || "",
                subsystem: alarm.subsystem || "",
            });
        }
        const level = highestAlarmLevel(alarms);
        if (level === "Critical") {
            worstLevel = "Critical";
            worstAlarm = alarms.find((a) => a.level === "Critical") || worstAlarm;
        } else if (level === "Warning" && worstLevel !== "Critical") {
            worstLevel = "Warning";
            if (!worstAlarm) {
                worstAlarm = alarms.find((a) => a.level === "Warning");
            }
        }
    }

    // Sort: Critical first, then Warning; stable by satellite id.
    allAlarms.sort((a, b) => {
        const rank = (lv) => (lv === "Critical" ? 0 : lv === "Warning" ? 1 : 2);
        const d = rank(a.level) - rank(b.level);
        if (d !== 0) return d;
        return String(a.satellite_id).localeCompare(String(b.satellite_id));
    });

    // Top banner (compact fleet summary) — existing UX.
    const alarmBanner = document.getElementById("alarmBanner");
    if (alarmBanner) {
        alarmBanner.classList.remove("visible", "level-warning", "level-critical", "alarm-flash");
        if (worstLevel === null) {
            alarmBanner.textContent = "";
        } else {
            const msg = worstAlarm
                ? (worstAlarm.message || worstAlarm.rule || worstLevel)
                : worstLevel;
            const sat = worstAlarm && worstAlarm.satellite_id
                ? worstAlarm.satellite_id
                : "";
            // Prefer satellite from aggregated list
            let satLabel = sat;
            if (!satLabel && allAlarms.length) {
                satLabel = allAlarms[0].satellite_id;
            }
            alarmBanner.textContent = satLabel
                ? `${worstLevel.toUpperCase()}: ${satLabel} — ${msg}`
                : `${worstLevel.toUpperCase()}: ${msg}`;
            alarmBanner.classList.add("visible");
            if (worstLevel === "Critical") {
                alarmBanner.classList.add("level-critical", "alarm-flash");
            } else {
                alarmBanner.classList.add("level-warning");
            }
        }
    }

    // Dedicated Active Alarms panel (Phase D #13).
    renderAlarmPanel(allAlarms, worstLevel);

    // Fleet panel chrome.
    const fleetPanel = document.querySelector(".panel-fleet");
    if (fleetPanel) {
        fleetPanel.classList.remove("fleet-alarm-critical", "fleet-alarm-warning");
        if (worstLevel === "Critical") {
            fleetPanel.classList.add("fleet-alarm-critical");
        } else if (worstLevel === "Warning") {
            fleetPanel.classList.add("fleet-alarm-warning");
        }
    }
}

function renderAlarmPanel(allAlarms, worstLevel) {
    const panel = document.getElementById("alarmPanel");
    const list = document.getElementById("alarmPanelList");
    const countEl = document.getElementById("alarmPanelCount");
    if (!panel || !list) return;

    panel.classList.remove("has-warning", "has-critical");
    if (worstLevel === "Critical") {
        panel.classList.add("has-critical");
    } else if (worstLevel === "Warning") {
        panel.classList.add("has-warning");
    }

    if (countEl) {
        countEl.textContent = String(allAlarms.length);
    }

    list.innerHTML = "";
    if (!allAlarms.length) {
        const empty = document.createElement("li");
        empty.className = "alarm-panel-empty";
        empty.id = "alarmPanelEmpty";
        empty.textContent = "No active alarms";
        list.appendChild(empty);
        return;
    }

    for (const alarm of allAlarms) {
        const li = document.createElement("li");
        const levelCss = statusClass(alarm.level);
        li.className = "alarm-panel-item level-" + (levelCss === "critical" ? "critical" : levelCss === "warning" ? "warning" : "unknown");

        const levelSpan = document.createElement("span");
        levelSpan.className = "alarm-panel-level";
        levelSpan.textContent = statusText(alarm.level);

        const satSpan = document.createElement("span");
        satSpan.className = "alarm-panel-sat";
        satSpan.textContent = alarm.satellite_id || "—";

        const msgSpan = document.createElement("span");
        msgSpan.className = "alarm-panel-msg";
        msgSpan.textContent = alarm.message || "Alarm";

        li.appendChild(levelSpan);
        li.appendChild(satSpan);
        li.appendChild(msgSpan);

        if (alarm.rule || alarm.subsystem) {
            const ruleSpan = document.createElement("span");
            ruleSpan.className = "alarm-panel-rule";
            const bits = [];
            if (alarm.subsystem) bits.push(alarm.subsystem);
            if (alarm.rule) bits.push(alarm.rule);
            ruleSpan.textContent = bits.join(" · ");
            li.appendChild(ruleSpan);
        }

        list.appendChild(li);
    }
}


function buildSubsystemHealthRows(subsystems) {
    SUBSYSTEM_LIST = subsystems || [];
    const container =
        typeof subsystemHealthContainer !== "undefined" && subsystemHealthContainer
            ? subsystemHealthContainer
            : document.getElementById("subsystemHealth");
    if (!container) {
        console.error("subsystemHealth container not found in DOM");
        return;
    }
    container.innerHTML = "";
    subsystemBadges = {};
    for (const subsystem of SUBSYSTEM_LIST) {
        const row = document.createElement("div");
        row.className = "subsystem-row";
        row.innerHTML = `
            <span class="subsystem-name">${subsystem.label}</span>
            <span class="subsystem-badge">---</span>
        `;
        container.appendChild(row);
        subsystemBadges[subsystem.key] = row.querySelector(".subsystem-badge");
    }
}
// `telemetry.subsystems` may be `{}` (or absent) — historical records from
// before this field existed, or from GET /telemetry/history in general,
// which doesn't backfill it (see backend/app/schemas/telemetry.py). Every
// access below goes through this defensive lookup rather than
// `telemetry.subsystems[key]` directly, so a missing/incomplete dict shows
// "---" instead of throwing.
function updateSubsystemHealthPanel(telemetry) {
    const subsystems = telemetry.subsystems || {};
    for (const [key, badge] of Object.entries(subsystemBadges)) {
        const state = subsystems[key];
        badge.className = "subsystem-badge " + (state ? statusClass(state) : "unknown");
        if (state) {
            badge.innerHTML = renderStatusIndicator(state);
        } else {
            badge.innerHTML = renderStatusIndicator(null);
        }
    }
}
// =========================
// Mission Timeline
// =========================
// Mission-wide chronological event log — unlike the fleet cards, map, and
// charts above, this one is NOT per-satellite: every satellite's events
// interleave into a single list here, newest event first, capped at the
// latest 100 VISIBLE entries (MAX_TIMELINE_EVENTS below) — the backend's
// `events` table (see backend/app/models/event.py) retains the complete,
// permanent history regardless of how many of them are currently shown
// here.
const MAX_TIMELINE_EVENTS = 100;
const timelineList = document.getElementById("missionTimeline");
function addTimelineEvent(satelliteId, eventType, description, timestamp) {
    const entryEl = document.createElement("li");
    entryEl.className = "timeline-entry timeline-" + eventType.toLowerCase();
    entryEl.innerHTML = `
        <span class="timeline-time">${new Date(timestamp).toLocaleTimeString()}</span>
        <span class="timeline-satellite">${satelliteId}</span>
        <span class="timeline-type">${eventType}</span>
        <span class="timeline-description">${description}</span>
    `;
    // Newest event at the top.
    timelineList.insertBefore(entryEl, timelineList.firstChild);
    // Keep only the latest MAX_TIMELINE_EVENTS entries VISIBLE. This is a
    // display trim only — it removes DOM rows, not database rows; the
    // backend's `events` table is unaffected and still has the full history.
    while (timelineList.children.length > MAX_TIMELINE_EVENTS) {
        timelineList.removeChild(timelineList.lastChild);
    }
}
// =========================
// Persistent mission events (Battery / Recovery / Warning / Critical)
// =========================
// Battery/Recovery/Warning/Critical events are decided and persisted
// entirely by the backend (backend/app/core/events.py) — this file never
// re-implements that edge-triggered comparison logic itself. Every such
// event reaches this file one of two ways: bootstrapped from
// `GET /events` on page load (see bootstrapEvents below), or live, via
// `telemetry.events` on the WebSocket telemetry broadcast (see
// pushTimelineEvents below). Both paths funnel through renderEvent() so
// the same satellite_id/timestamp/event_type/message are always rendered
// the same way, and so the same event is never rendered twice even if it
// arrives via both paths (e.g. a live event that gets persisted, then
// shows up again in a later GET /events call after a page refresh).
// Tracks which events have already been rendered into the Mission
// Timeline DOM, so the same persisted event is never shown twice even if
// it's seen via both the GET /events bootstrap and a live WebSocket
// message (a live event could in principle arrive while bootstrapEvents()
// is still in flight, or a page refresh could re-bootstrap an event
// that's already on screen).
const renderedEventIds = new Set();
// The database event ID (`event.id`) is the preferred, authoritative
// dedup key — two distinct persisted events can otherwise have identical
// satellite/timestamp/type/message (e.g. the same alarm firing again
// later), so deduplicating on message text alone would be wrong; the ID
// is the one thing guaranteed unique per persisted event. A composite
// fallback key is used only if an event somehow arrives without an ID —
// not expected in practice, since every Event row already has one by the
// time it's broadcast or returned by GET /events, but this keeps
// rendering safe rather than throwing if that assumption is ever wrong.
function eventKey(event) {
    if (event.id !== undefined && event.id !== null) {
        return "id:" + event.id;
    }
    return [
        "fallback",
        event.satellite_id,
        event.timestamp,
        event.event_type,
        event.rule,
    ].join("|");
}
function renderEvent(event) {
    const key = eventKey(event);
    if (renderedEventIds.has(key)) {
        return;
    }
    renderedEventIds.add(key);
    addTimelineEvent(event.satellite_id, event.event_type, event.message, event.timestamp);
}
// Fetched once at startup (see initDashboard) to populate the Mission
// Timeline with the persistent event history — this is what makes
// historical anomalies still visible after a browser refresh or a
// backend restart, unlike "Telemetry received" below, which only ever
// exists for the current page session.
async function bootstrapEvents(config) {
    try {
        const response = await fetch(`${config.api_url}/events?limit=100`);
        const events = await response.json();
        if (!Array.isArray(events)) {
            return;
        }
        // Newest-first from the API; replay oldest-first so the final
        // insertBefore-based rendering in addTimelineEvent() ends up
        // newest-at-top — same reasoning as bootstrapFleet() below.
        events.slice().reverse().forEach(renderEvent);
    } catch (error) {
        console.error("Failed to load mission event history:", error);
    }
}
// Derives the mission-timeline entries implied by one telemetry sample.
// Called from updateDashboard() for both the live WebSocket stream and
// the bootstrap history replay, so "Telemetry received" rows keep
// appearing for both, exactly as before.
function pushTimelineEvents(telemetry) {
    // Telemetry received — generated every packet, unconditionally, and
    // entirely client-side. Deliberately NOT a persisted backend event —
    // see the module docstring in backend/app/models/event.py: it isn't
    // an anomaly, so it exists only for the current page session, the
    // same way it always has.
    addTimelineEvent(
        telemetry.satellite_id,
        "Telemetry",
        "Telemetry received",
        telemetry.timestamp
    );
    // Battery/Recovery/Warning/Critical — whatever new persistent events
    // this telemetry sample produced, already decided by the backend (see
    // backend/app/core/events.py) and attached to this same WebSocket
    // message. Empty on most packets (nothing new happened); GET
    // /telemetry/history-sourced bootstrap samples don't carry an
    // `events` key at all, hence the `|| []`.
    for (const event of telemetry.events || []) {
        renderEvent(event);
    }
}
// =========================
// Command Uplink — SIMULATION ONLY
// =========================
// Backend-authoritative: this file only sends commands and displays
// whatever backend/app/core/commands.py decides. It never computes a
// command's effect itself. Scoped to `selectedSatelliteId` — the SAME
// selector already used for Live Telemetry/Subsystem Health, per "use the
// existing fleet state and selectors, don't build a second interface."
const commandPayloadStateEl = document.getElementById("commandPayloadState");
const commandOperatingModeStateEl = document.getElementById("commandOperatingModeState");
const commandComputerStateEl = document.getElementById("commandComputerState");
const subsystemHealthContainer = document.getElementById("subsystemHealth");
const commandStatusEl = document.getElementById("commandStatus");
const commandHistoryEl = document.getElementById("commandHistory");
const enablePayloadBtn = document.getElementById("enablePayloadBtn");
const restartComputerBtn = document.getElementById("restartComputerBtn");
const changeModeBtn = document.getElementById("changeModeBtn");
const enterSafeModeBtn = document.getElementById("enterSafeModeBtn");
const modeSelect = document.getElementById("modeSelect");
const COMMAND_BUTTONS = [enablePayloadBtn, restartComputerBtn, changeModeBtn, enterSafeModeBtn];
// The most recent command THIS browser tab sent, so live command_update
// messages (which arrive for every command, from every client) only
// update the "latest command status" line when they're actually about
// the command this tab is tracking, rather than showing whichever
// satellite/operator last touched anything.
let trackedCommandId = null;
function setCommandButtonsDisabled(disabled) {
    for (const button of COMMAND_BUTTONS) {
        button.disabled = disabled;
    }
}
function renderSatelliteState(state) {
    commandPayloadStateEl.textContent = state.payload_enabled ? "Enabled" : "Disabled";
    commandOperatingModeStateEl.textContent = state.operating_mode;
    commandComputerStateEl.textContent = state.computer_state;
}
async function fetchSatelliteState(satelliteId) {
    if (!dashboardConfig) {
        return;
    }
    try {
        const response = await fetch(`${dashboardConfig.api_url}/satellite-state/${satelliteId}`);
        if (!response.ok) {
            return;
        }
        const state = await response.json();
        if (satelliteId === selectedSatelliteId) {
            renderSatelliteState(state);
        }
    } catch (error) {
        console.error("Failed to load satellite state:", error);
    }
}
function addCommandHistoryEntry(command) {
    const entryEl = document.createElement("li");
    entryEl.className = "command-history-entry";
    entryEl.innerHTML = `
        <span class="command-history-time">${new Date(command.created_at).toLocaleTimeString()}</span>
        <span class="command-history-satellite">${command.satellite_id}</span>
        <span class="command-history-status status-${command.status.toLowerCase()}">${command.status}</span>
        <span>${command.command_type}${command.parameters ? " (" + JSON.stringify(command.parameters) + ")" : ""}</span>
    `;
    commandHistoryEl.insertBefore(entryEl, commandHistoryEl.firstChild);
    while (commandHistoryEl.children.length > 20) {
        commandHistoryEl.removeChild(commandHistoryEl.lastChild);
    }
}
async function fetchCommandHistory(satelliteId) {
    if (!dashboardConfig) {
        return;
    }
    commandHistoryEl.innerHTML = "";
    try {
        const response = await fetch(
            `${dashboardConfig.api_url}/commands?satellite_id=${encodeURIComponent(satelliteId)}&limit=20`
        );
        if (!response.ok) {
            return;
        }
        const commands = await response.json();
        if (!Array.isArray(commands) || satelliteId !== selectedSatelliteId) {
            return;
        }
        // Newest-first from the API; replay oldest-first so the final
        // insertBefore-based rendering ends up newest-at-top — same
        // pattern as bootstrapFleet()/bootstrapEvents() above.
        commands.slice().reverse().forEach(addCommandHistoryEntry);
    } catch (error) {
        console.error("Failed to load command history:", error);
    }
}
// Called whenever the selected satellite changes (see showSatellite() and
// getOrCreateFleetEntry() below) to load that satellite's current state
// and recent command history fresh.
function refreshCommandUplinkPanel(satelliteId) {
    if (!satelliteId) {
        return;
    }
    fetchSatelliteState(satelliteId);
    fetchCommandHistory(satelliteId);
}
function updateCommandStatusLine(command) {
    commandStatusEl.className = "command-status status-" + command.status.toLowerCase();
    if (command.status === "FAILED") {
        commandStatusEl.textContent =
            `${command.satellite_id}: ${command.command_type} FAILED — ${command.failure_reason || "unknown reason"}`;
    } else {
        commandStatusEl.textContent = `${command.satellite_id}: ${command.command_type} — ${command.status}`;
    }
}
// Handles a live "command_update" WebSocket message — see the dispatch in
// initDashboard()'s socket.onmessage below. NEVER passed into
// updateDashboard(): a command_update message has no telemetry fields
// (latitude/battery/etc.), so treating it as telemetry would throw.
function handleCommandUpdate(message) {
    if (message.id === trackedCommandId || message.satellite_id === selectedSatelliteId) {
        updateCommandStatusLine(message);
    }
    if (message.status === "EXECUTED" || message.status === "FAILED") {
        setCommandButtonsDisabled(false);
        addCommandHistoryEntry(message);
        if (message.satellite_id === selectedSatelliteId) {
            fetchSatelliteState(selectedSatelliteId);
        }
    }
    // The command's terminal mission Event, if any (see
    // backend/app/core/commands.py's _finish()) — rendered through the
    // exact same renderEvent()/eventKey() dedup path as every other event,
    // so it can never appear twice even if GET /events later returns it
    // again after a page refresh.
    if (message.event) {
        renderEvent(message.event);
    }
}
async function sendCommand(satelliteId, commandType, parameters) {
    if (!dashboardConfig) {
        return;
    }
    setCommandButtonsDisabled(true);
    commandStatusEl.className = "command-status status-queued";
    commandStatusEl.textContent = `${satelliteId}: ${commandType} — sending...`;
    try {
        const response = await fetch(`${dashboardConfig.api_url}/commands`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                satellite_id: satelliteId,
                command: commandType,
                parameters: parameters || null,
            }),
        });
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            commandStatusEl.className = "command-status status-failed";
            commandStatusEl.textContent =
                `${satelliteId}: ${commandType} rejected — ${body.detail || response.status}`;
            setCommandButtonsDisabled(false);
            return;
        }
        const command = await response.json();
        trackedCommandId = command.id;
        updateCommandStatusLine(command);
        // Buttons re-enable when the live command_update WebSocket message
        // reports EXECUTED/FAILED (see handleCommandUpdate above) — not
        // here, since this response is only the initial QUEUED state.
    } catch (error) {
        console.error("Failed to send command:", error);
        commandStatusEl.className = "command-status status-failed";
        commandStatusEl.textContent = `${satelliteId}: ${commandType} — request failed`;
        setCommandButtonsDisabled(false);
    }
}
enablePayloadBtn.addEventListener("click", () => {
    if (selectedSatelliteId) {
        sendCommand(selectedSatelliteId, "ENABLE_PAYLOAD", null);
    }
});
restartComputerBtn.addEventListener("click", () => {
    if (selectedSatelliteId) {
        sendCommand(selectedSatelliteId, "RESTART_COMPUTER", null);
    }
});
changeModeBtn.addEventListener("click", () => {
    if (selectedSatelliteId) {
        sendCommand(selectedSatelliteId, "CHANGE_MODE", { mode: modeSelect.value });
    }
});
enterSafeModeBtn.addEventListener("click", () => {
    if (selectedSatelliteId) {
        sendCommand(selectedSatelliteId, "ENTER_SAFE_MODE", null);
    }
});
// =========================
// Detail panel (Live Telemetry card) — selector-scoped
// =========================
// Circular gauge geometry: radius 36 in the 100×100 viewBox.
// Circumference = 2πr ≈ 226.1947 — used as stroke-dasharray length.
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 36;

// Temperature is not a percentage. Ring fill maps a fixed display range
// to 0–100% of the arc only — this does NOT define alarm thresholds.
// Status (NOMINAL/WARNING/CRITICAL) still comes from
// metricHealthFromTelemetry() (thermal subsystem / backend alarms).
const TEMP_GAUGE_MIN_C = 0;
const TEMP_GAUGE_MAX_C = 50;

function setGaugeRing(fillEl, percent, statusCss) {
    if (!fillEl) {
        return;
    }
    const clamped = Math.max(0, Math.min(100, percent));
    const offset = GAUGE_CIRCUMFERENCE * (1 - clamped / 100);
    fillEl.style.strokeDasharray = String(GAUGE_CIRCUMFERENCE);
    fillEl.style.strokeDashoffset = String(offset);
    fillEl.className = "gauge-fill " + (statusCss || "unknown");
}

function setGaugeStatus(statusEl, status) {
    if (!statusEl) {
        return;
    }
    const normalized = normalizeStatus(status);
    const css = normalized ? statusClass(normalized) : "unknown";
    statusEl.textContent = normalized ? statusText(normalized) : "---";
    statusEl.className = "gauge-status " + css;
    return css;
}

function updateCircularGauge(valueElId, fillElId, statusElId, valueText, ringPercent, healthStatus) {
    const valueEl = document.getElementById(valueElId);
    if (valueEl) {
        valueEl.textContent = valueText;
    }
    const css = setGaugeStatus(document.getElementById(statusElId), healthStatus);
    setGaugeRing(document.getElementById(fillElId), ringPercent, css);
}

function updateDetailPanel(telemetry) {
    // FIRST: sparkline numeric labels (same packet as gauges).
    // If these stay "—", this function is not the one the browser is running.
    try {
        const bm = document.getElementById("batteryMetricValue");
        const tm = document.getElementById("temperatureMetricValue");
        const sm = document.getElementById("signalMetricValue");
        const cm = document.getElementById("cpuMetricValue");
        if (bm) bm.textContent = Number(telemetry.battery).toFixed(1) + "%";
        if (tm) tm.textContent = Number(telemetry.temperature).toFixed(1) + "°C";
        if (sm) sm.textContent = Number(telemetry.signal_strength).toFixed(1) + "%";
        if (cm) cm.textContent = Number(telemetry.cpu_load).toFixed(1) + "%";
    } catch (err) {
        console.error("[MCGS] sparkline value write failed", err);
    }

    document.getElementById("satellite").textContent =
        telemetry.satellite_id;

    const batteryStatus = metricHealthFromTelemetry(telemetry, "battery");
    updateCircularGauge(
        "battery",
        "gaugeBatteryFill",
        "gaugeBatteryStatus",
        telemetry.battery.toFixed(1) + "%",
        telemetry.battery,
        batteryStatus
    );

    const cpuStatus = metricHealthFromTelemetry(telemetry, "cpu");
    updateCircularGauge(
        "cpu",
        "gaugeCpuFill",
        "gaugeCpuStatus",
        telemetry.cpu_load.toFixed(1) + "%",
        telemetry.cpu_load,
        cpuStatus
    );

    const signalStatus = metricHealthFromTelemetry(telemetry, "signal");
    updateCircularGauge(
        "signal",
        "gaugeSignalFill",
        "gaugeSignalStatus",
        telemetry.signal_strength.toFixed(1) + "%",
        telemetry.signal_strength,
        signalStatus
    );

    const temperatureStatus = metricHealthFromTelemetry(telemetry, "temperature");
    const tempSpan = TEMP_GAUGE_MAX_C - TEMP_GAUGE_MIN_C;
    const tempRingPercent =
        tempSpan > 0
            ? ((telemetry.temperature - TEMP_GAUGE_MIN_C) / tempSpan) * 100
            : 0;
    updateCircularGauge(
        "temperature",
        "gaugeTemperatureFill",
        "gaugeTemperatureStatus",
        telemetry.temperature.toFixed(1) + "°C",
        tempRingPercent,
        temperatureStatus
    );

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

    // --- Sparklines (Telemetry Status strip) -----------------------------
    // Numbers come from the same live telemetry packet as the gauges so
    // they cannot stay at "—" while gauges show real values. SVG trends
    // use the per-satellite history bag (filled by pushChartHistory).
    const setMetricValue = (id, text) => {
        const el = document.getElementById(id);
        if (el) {
            el.textContent = text;
        }
    };
    setMetricValue(
        "batteryMetricValue",
        Number.isFinite(telemetry.battery)
            ? telemetry.battery.toFixed(1) + "%"
            : "—"
    );
    setMetricValue(
        "temperatureMetricValue",
        Number.isFinite(telemetry.temperature)
            ? telemetry.temperature.toFixed(1) + "°C"
            : "—"
    );
    setMetricValue(
        "signalMetricValue",
        Number.isFinite(telemetry.signal_strength)
            ? telemetry.signal_strength.toFixed(1) + "%"
            : "—"
    );
    setMetricValue(
        "cpuMetricValue",
        Number.isFinite(telemetry.cpu_load)
            ? telemetry.cpu_load.toFixed(1) + "%"
            : "—"
    );

    const sparkEntry = fleet.get(telemetry.satellite_id);
    if (sparkEntry) {
        try {
            renderSparkline(
                document.getElementById("batterySparkline"),
                sparkEntry.batteryHistory && sparkEntry.batteryHistory.values
            );
            renderSparkline(
                document.getElementById("temperatureSparkline"),
                sparkEntry.temperatureHistory && sparkEntry.temperatureHistory.values
            );
            renderSparkline(
                document.getElementById("signalSparkline"),
                sparkEntry.signalHistory && sparkEntry.signalHistory.values
            );
            renderSparkline(
                document.getElementById("cpuSparkline"),
                sparkEntry.cpuHistory && sparkEntry.cpuHistory.values
            );
        } catch (err) {
            console.error("sparkline SVG update failed:", err);
        }
    }
}
// =========================
// Fleet entry lifecycle
// =========================
function getOrCreateFleetEntry(satelliteId) {
    if (fleet.has(satelliteId)) {
        return fleet.get(satelliteId);
    }
    const color = getSatelliteColor(fleet.size);
    const { marker, trail, predictedTrail } = createMapEntities(color);
    const card = createFleetCard(satelliteId, color);
    const option = document.createElement("option");
    option.value = satelliteId;
    option.textContent = satelliteId;
    satelliteSelector.appendChild(option);
    const entry = {
        color,
        marker,
        trail,
        trailPoints: [],
        predictedTrail,
        card,
        latest: null,
        activeAlarms: [],
        batteryHistory: { labels: [], values: [] },
        temperatureHistory: { labels: [], values: [] },
        signalHistory: { labels: [], values: [] },
        cpuHistory: { labels: [], values: [] },
    };
    fleet.set(satelliteId, entry);
    // Auto-select the first satellite ever seen, so the detail panel and
    // charts aren't empty while waiting for the operator to pick one.
    if (selectedSatelliteId === null) {
        selectedSatelliteId = satelliteId;
        satelliteSelector.value = satelliteId;
        refreshCommandUplinkPanel(satelliteId);
        updateMissionHeader();
    }
    return entry;
}
// =========================
// Main update entry point
// =========================
// isBootstrap is set during the initial fleet-history replay (see
// bootstrapFleet below) so that page load doesn't fire ~20 rapid,
// visually-flickery map.panTo() calls before settling.
function updateDashboard(telemetry, isBootstrap = false) {
    const entry = getOrCreateFleetEntry(telemetry.satellite_id);
    entry.latest = telemetry;
    noteTelemetryPacket(telemetry, isBootstrap);
    updateFleetCard(entry, telemetry);
    updateMapMarker(entry, telemetry);
    updateAlarmVisuals(entry, telemetry);
    updateAlarmBanner();
    // In historical-replay mode, do not append live samples into the
    // selected satellite's chart/sparkline buffers (they show the loaded window).
    const freezeCharts =
        replayActive && telemetry.satellite_id === selectedSatelliteId;
    if (!freezeCharts) {
        pushChartHistory(entry, telemetry);
    }
    pushTimelineEvents(telemetry);
    if (telemetry.satellite_id === selectedSatelliteId) {
        if (!replayActive) {
            updateDetailPanel(telemetry);
            updateSubsystemHealthPanel(telemetry);
            try {
                renderChartsFor(entry);
            } catch (err) {
                console.error("renderChartsFor:", err);
            }
            try {
                renderSparklinesFor(entry);
            } catch (err) {
                console.error("renderSparklinesFor:", err);
            }
        }
        if (trackingEnabled && !isBootstrap && !replayActive) {
            map.panTo(
                [telemetry.latitude, telemetry.longitude],
                { animate: true }
            );
        }
        updateMissionHeader();
    }
}
// =========================
// Backend-config-dependent bootstrap
// =========================
// Everything that needs to know the backend's real URLs (or the subsystem
// list) waits for this to complete, instead of being hardcoded at
// module-load time.

// =========================
// Historical Replay (Phase C #11)
// =========================
// Uses existing GET /telemetry/history (from / to / limit / satellite_id).
// Does not add backend endpoints. Live WebSocket stays open; only the
// selected satellite's plots/gauges/sparklines switch to the history window.

function setReplayStatus(text, modeClass) {
    const el = document.getElementById("replayStatus");
    if (!el) return;
    el.textContent = text;
    el.className = "replay-status" + (modeClass ? " " + modeClass : "");
}

function clearSatelliteHistory(entry) {
    if (!entry) return;
    for (const key of ["batteryHistory", "temperatureHistory", "signalHistory", "cpuHistory"]) {
        entry[key] = { labels: [], values: [] };
    }
}

function rangeToIsoWindow(rangeKey, customFrom, customTo) {
    const now = new Date();
    let from = null;
    let to = now;
    if (rangeKey === "1h") {
        from = new Date(now.getTime() - 60 * 60 * 1000);
    } else if (rangeKey === "24h") {
        from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    } else if (rangeKey === "today") {
        from = new Date(now);
        from.setUTCHours(0, 0, 0, 0);
    } else if (rangeKey === "custom") {
        if (!customFrom || !customTo) {
            throw new Error("Custom range requires From and To");
        }
        from = new Date(customFrom);
        to = new Date(customTo);
        if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
            throw new Error("Invalid custom datetime");
        }
        if (from >= to) {
            throw new Error("From must be before To");
        }
    } else {
        return null; // live
    }
    return {
        fromIso: from.toISOString(),
        toIso: to.toISOString(),
    };
}

function applyHistoryRecordsToEntry(entry, records) {
    clearSatelliteHistory(entry);
    // API returns newest-first; replay oldest-first for charts.
    const ordered = records.slice().reverse();
    for (const telemetry of ordered) {
        pushChartHistory(entry, telemetry);
    }
    // Time slider buffer (same chronological order).
    replayRecords = ordered.slice();
    replayIndex = Math.max(0, replayRecords.length - 1);
    const latest = ordered.length ? ordered[ordered.length - 1] : null;
    if (latest) {
        entry.latest = latest;
        updateDetailPanel(latest);
        updateSubsystemHealthPanel(latest);
        // Place selected sat marker at the end of the window.
        updateMapMarker(entry, latest);
    }
    try {
        renderChartsFor(entry);
    } catch (err) {
        console.error("renderChartsFor (replay):", err);
    }
    try {
        renderSparklinesFor(entry);
    } catch (err) {
        console.error("renderSparklinesFor (replay):", err);
    }
    syncTimeSliderUi();
    seekReplayToIndex(replayIndex, false);
}

async function loadHistoricalReplay(rangeKey) {
    if (!dashboardConfig) {
        console.warn("Replay: config not ready");
        return;
    }
    if (!selectedSatelliteId) {
        setReplayStatus("NO SAT", "replay");
        return;
    }
    if (rangeKey === "live") {
        exitReplayToLive();
        return;
    }

    const fromInput = document.getElementById("replayFrom");
    const toInput = document.getElementById("replayTo");
    let windowSpec;
    try {
        windowSpec = rangeToIsoWindow(
            rangeKey,
            fromInput && fromInput.value,
            toInput && toInput.value
        );
    } catch (err) {
        setReplayStatus("INVALID", "replay");
        console.error(err);
        return;
    }
    if (!windowSpec) {
        exitReplayToLive();
        return;
    }

    setReplayStatus("LOADING", "loading");
    const params = new URLSearchParams();
    params.set("satellite_id", selectedSatelliteId);
    params.set("from", windowSpec.fromIso);
    params.set("to", windowSpec.toIso);
    params.set("limit", "500");

    try {
        const response = await fetch(
            `${dashboardConfig.api_url}/telemetry/history?${params.toString()}`
        );
        if (!response.ok) {
            throw new Error("history HTTP " + response.status);
        }
        const records = await response.json();
        if (!Array.isArray(records)) {
            throw new Error("history response is not an array");
        }
        const entry = getOrCreateFleetEntry(selectedSatelliteId);
        // Temporarily mark not-replay so pushChartHistory will fill buffers
        const prev = replayActive;
        replayActive = false;
        // Suppress per-sample sparkline spam during bulk fill by clearing selected match trick:
        // pushChartHistory only refreshes strip when satellite_id === selectedSatelliteId —
        // that's fine; slightly chatty but OK for portfolio limit 500.
        applyHistoryRecordsToEntry(entry, records);
        replayActive = true;
        replayMode = rangeKey;
        setReplayStatus(
            records.length ? ("REPLAY · " + records.length) : "EMPTY",
            "replay"
        );
        const sourceEl = document.getElementById("mhSource");
        if (sourceEl) {
            sourceEl.textContent = "Replay";
            sourceEl.className = "mh-value offline";
        }
    } catch (err) {
        console.error("Historical replay failed:", err);
        setReplayStatus("ERROR", "replay");
    }
}

function exitReplayToLive() {
    stopTimeSliderPlayback();
    replayActive = false;
    replayMode = "live";
    replayRecords = [];
    replayIndex = 0;
    setReplayStatus("LIVE", "");
    const select = document.getElementById("replayRangeSelect");
    if (select) select.value = "live";
    const custom = document.getElementById("replayCustomFields");
    if (custom) custom.hidden = true;
    const bar = document.getElementById("timeSliderBar");
    if (bar) bar.hidden = true;
    // Resume live presentation from latest packet already on the entry
    if (selectedSatelliteId && fleet.has(selectedSatelliteId)) {
        const entry = fleet.get(selectedSatelliteId);
        if (entry && entry.latest) {
            updateDetailPanel(entry.latest);
            updateSubsystemHealthPanel(entry.latest);
            try { renderChartsFor(entry); } catch (e) { /* ignore */ }
            try { renderSparklinesFor(entry); } catch (e) { /* ignore */ }
        }
    }
    updateMissionHeader();
}


// =========================
// Time Slider (Phase C #12)
// =========================
// Scrub through replayRecords (loaded history window). Updates gauges,
// detail table, subsystem health, and the selected satellite map marker.
// Charts keep the full-window series; the cursor is the instantaneous state.

function formatSliderStamp(timestamp) {
    if (!timestamp) return "—";
    const d = new Date(timestamp);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function syncTimeSliderUi() {
    const bar = document.getElementById("timeSliderBar");
    const slider = document.getElementById("timeSlider");
    const idxEl = document.getElementById("timeSliderIndex");
    const stampEl = document.getElementById("timeSliderStamp");
    if (!bar || !slider) return;

    const n = replayRecords.length;
    if (!replayActive || n === 0) {
        bar.hidden = true;
        slider.disabled = true;
        slider.value = "0";
        slider.max = "0";
        if (idxEl) idxEl.textContent = "0 / 0";
        if (stampEl) stampEl.textContent = "—";
        return;
    }

    bar.hidden = false;
    slider.disabled = false;
    slider.min = "0";
    slider.max = String(n - 1);
    slider.value = String(Math.min(replayIndex, n - 1));
    if (idxEl) {
        idxEl.textContent = (replayIndex + 1) + " / " + n;
    }
    const sample = replayRecords[replayIndex];
    if (stampEl) {
        stampEl.textContent = sample ? formatSliderStamp(sample.timestamp) : "—";
    }
}

function seekReplayToIndex(index, updateSliderInput) {
    if (!replayRecords.length) return;
    const n = replayRecords.length;
    const i = Math.max(0, Math.min(n - 1, index | 0));
    replayIndex = i;
    const sample = replayRecords[i];
    if (!sample) return;

    const entry = fleet.get(sample.satellite_id) || getOrCreateFleetEntry(sample.satellite_id);
    // Instantaneous operator view at scrub time — does not rewrite chart series.
    updateDetailPanel(sample);
    updateSubsystemHealthPanel(sample);
    updateMapMarker(entry, sample);
    if (trackingEnabled) {
        map.panTo([sample.latitude, sample.longitude], { animate: false });
    }

    const lastPacketEl = document.getElementById("mhLastPacket");
    if (lastPacketEl) {
        lastPacketEl.textContent = formatPacketTimeUtc(sample.timestamp);
    }

    if (updateSliderInput !== false) {
        const slider = document.getElementById("timeSlider");
        if (slider) slider.value = String(i);
    }
    syncTimeSliderUi();
}

function stopTimeSliderPlayback() {
    if (timeSliderPlayTimer != null) {
        clearInterval(timeSliderPlayTimer);
        timeSliderPlayTimer = null;
    }
    const btn = document.getElementById("timeSliderPlay");
    if (btn) {
        btn.textContent = "▶";
        btn.classList.remove("playing");
    }
}

function toggleTimeSliderPlayback() {
    if (timeSliderPlayTimer != null) {
        stopTimeSliderPlayback();
        return;
    }
    if (!replayActive || replayRecords.length < 2) return;
    const btn = document.getElementById("timeSliderPlay");
    if (btn) {
        btn.textContent = "❚❚";
        btn.classList.add("playing");
    }
    timeSliderPlayTimer = setInterval(function () {
        if (!replayRecords.length) {
            stopTimeSliderPlayback();
            return;
        }
        let next = replayIndex + 1;
        if (next >= replayRecords.length) {
            stopTimeSliderPlayback();
            return;
        }
        seekReplayToIndex(next, true);
    }, 400);
}

function wireTimeSliderControls() {
    const slider = document.getElementById("timeSlider");
    const playBtn = document.getElementById("timeSliderPlay");
    if (slider) {
        slider.addEventListener("input", function () {
            stopTimeSliderPlayback();
            seekReplayToIndex(Number(slider.value), false);
        });
    }
    if (playBtn) {
        playBtn.addEventListener("click", function () {
            toggleTimeSliderPlayback();
        });
    }
}

function wireHistoricalReplayControls() {
    const select = document.getElementById("replayRangeSelect");
    const custom = document.getElementById("replayCustomFields");
    const applyBtn = document.getElementById("replayApplyBtn");
    if (!select) return;

    select.addEventListener("change", () => {
        const v = select.value;
        if (custom) {
            custom.hidden = v !== "custom";
        }
        if (v === "live") {
            exitReplayToLive();
            return;
        }
        if (v === "custom") {
            setReplayStatus("SET RANGE", "replay");
            return;
        }
        loadHistoricalReplay(v);
    });

    if (applyBtn) {
        applyBtn.addEventListener("click", () => {
            loadHistoricalReplay("custom");
        });
    }
}


// =========================
// Connection Monitor (Phase D)
// =========================
// Honest client-side link metrics. Does not invent packet-loss counters
// from the backend. "Gaps (est.)" counts inter-packet intervals that are
// > 2× the configured update_rate while the WebSocket is open.
// Database is inferred from REST /config reachability (no DB probe API).

function setConnValue(id, text, cls) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = "conn-value" + (cls ? " " + cls : "");
}

function pulseFleetCard(satelliteId) {
    const entry = fleet.get(satelliteId);
    if (!entry || !entry.card) return;
    entry.card.classList.remove("packet-pulse");
    // restart CSS animation
    void entry.card.offsetWidth;
    entry.card.classList.add("packet-pulse");
}

function noteTelemetryPacket(telemetry, isBootstrap) {
    if (isBootstrap) {
        // Bootstrap history is not live link traffic.
        return;
    }
    const now = performance.now();
    connPacketsRx += 1;
    if (telemetry && telemetry.satellite_id) {
        pulseFleetCard(telemetry.satellite_id);
    }
    if (connLastPacketMs != null && connExpectedIntervalSec != null) {
        const dtSec = (now - connLastPacketMs) / 1000;
        // Count estimated missing samples if gap exceeds 2× cadence.
        if (dtSec > connExpectedIntervalSec * 2.0) {
            const missing = Math.max(
                0,
                Math.round(dtSec / connExpectedIntervalSec) - 1
            );
            connGapEstimate += missing;
        }
    }
    connLastPacketMs = now;
    renderConnectionMonitor();
}

function renderConnectionMonitor() {
    setConnValue("connPacketsRx", String(connPacketsRx), "ok");
    setConnValue(
        "connPacketsLost",
        String(connGapEstimate),
        connGapEstimate > 0 ? "warn" : "dim"
    );

    if (connLastPacketMs == null) {
        setConnValue("connLatency", "—", "dim");
    } else {
        const ageMs = Math.round(performance.now() - connLastPacketMs);
        let cls = "ok";
        if (ageMs > 10000) cls = "bad";
        else if (ageMs > 5000) cls = "warn";
        setConnValue("connLatency", ageMs + " ms ago", cls);
    }

    if (wsConnected) {
        setConnValue("connWs", "ONLINE", "ok conn-live");
    } else {
        setConnValue("connWs", "OFFLINE", "bad");
    }

    if (connRestOk === true) {
        const lat =
            connRestLatencyMs != null ? " · " + connRestLatencyMs + " ms" : "";
        setConnValue("connRest", "OK" + lat, "ok");
        setConnValue("connDb", "OK*", "ok");
    } else if (connRestOk === false) {
        setConnValue("connRest", "FAIL", "bad");
        setConnValue("connDb", "UNKNOWN", "warn");
    } else {
        setConnValue("connRest", "—", "dim");
        setConnValue("connDb", "—", "dim");
    }
}

async function probeRestHealth() {
    if (!dashboardConfig || !dashboardConfig.api_url) {
        // Fall back to BACKEND_ORIGIN /config
    }
    const url = (dashboardConfig && dashboardConfig.api_url)
        ? dashboardConfig.api_url.replace(/\/$/, "") + "/../config"
        : BACKEND_ORIGIN + "/config";
    // Prefer known good endpoint
    const probeUrl = BACKEND_ORIGIN + "/config";
    const t0 = performance.now();
    try {
        const response = await fetch(probeUrl, { cache: "no-store" });
        const t1 = performance.now();
        connRestLatencyMs = Math.round(t1 - t0);
        connRestOk = response.ok;
    } catch (err) {
        connRestOk = false;
        connRestLatencyMs = null;
    }
    renderConnectionMonitor();
}

function startConnectionMonitor() {
    renderConnectionMonitor();
    probeRestHealth();
    // Refresh age display + periodic REST probe
    setInterval(function () {
        renderConnectionMonitor();
    }, 1000);
    setInterval(probeRestHealth, 15000);
}


// =========================
// Phase G — Professional polish
// =========================

function downloadTextFile(filename, text, mime) {
    const blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
}

function exportTelemetryCsv() {
    const lines = [
        "satellite_id,timestamp,latitude,longitude,altitude_km,velocity_km_s,battery_pct,signal_pct,cpu_load_pct,temperature_c,status",
    ];
    for (const entry of fleet.values()) {
        const t = entry.latest;
        if (!t) continue;
        const row = [
            t.satellite_id,
            t.timestamp,
            t.latitude,
            t.longitude,
            t.altitude,
            t.velocity,
            t.battery,
            t.signal_strength,
            t.cpu_load,
            t.temperature,
            t.status,
        ].map(function (v) {
            if (v == null) return "";
            const s = String(v);
            return s.indexOf(",") >= 0 ? '"' + s.replace(/"/g, '""') + '"' : s;
        });
        lines.push(row.join(","));
        // Include chart history points for selected depth
        const n = Math.min(
            (entry.batteryHistory && entry.batteryHistory.values.length) || 0,
            60
        );
        for (let i = 0; i < n; i++) {
            const ts = entry.batteryHistory.labels[i] || "";
            lines.push(
                [
                    t.satellite_id,
                    ts,
                    "",
                    "",
                    "",
                    "",
                    entry.batteryHistory.values[i],
                    entry.signalHistory && entry.signalHistory.values[i],
                    entry.cpuHistory && entry.cpuHistory.values[i],
                    entry.temperatureHistory && entry.temperatureHistory.values[i],
                    "",
                ].join(",")
            );
        }
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    downloadTextFile("mcgs-telemetry-" + stamp + ".csv", lines.join("\n"), "text/csv;charset=utf-8");
}

function exportMissionReport() {
    const lines = [];
    lines.push("MCGS MISSION REPORT");
    lines.push("Generated: " + new Date().toISOString());
    lines.push("Selected: " + (selectedSatelliteId || "—"));
    lines.push("WebSocket: " + (wsConnected ? "ONLINE" : "OFFLINE"));
    lines.push("Packets RX: " + connPacketsRx + " | Gaps est.: " + connGapEstimate);
    lines.push("");
    lines.push("=== FLEET ===");
    for (const entry of fleet.values()) {
        const t = entry.latest;
        if (!t) continue;
        lines.push(
            t.satellite_id +
                " | " +
                (t.status || "—") +
                " | BAT " +
                (Number.isFinite(t.battery) ? t.battery.toFixed(1) + "%" : "—") +
                " | SIG " +
                (Number.isFinite(t.signal_strength) ? t.signal_strength.toFixed(1) + "%" : "—") +
                " | " +
                formatLocation(t.latitude, t.longitude)
        );
    }
    lines.push("");
    lines.push("=== ACTIVE ALARMS ===");
    let alarmCount = 0;
    for (const entry of fleet.values()) {
        const alarms = entry.activeAlarms || [];
        for (const a of alarms) {
            alarmCount += 1;
            lines.push(
                (a.level || "?") +
                    " | " +
                    (a.satellite_id || entry.card && entry.card.dataset.satelliteId || "") +
                    " | " +
                    (a.message || a.rule || JSON.stringify(a))
            );
        }
    }
    if (alarmCount === 0) lines.push("(none)");
    lines.push("");
    lines.push("=== NOTES ===");
    lines.push("Orbit propagation uses ISS (ZARYA) TLE stand-in (simulation).");
    lines.push("Database status is inferred from REST /config reachability.");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    downloadTextFile(
        "mcgs-mission-report-" + stamp + ".txt",
        lines.join("\n"),
        "text/plain;charset=utf-8"
    );
}

function takeScreenshot() {
    // Lightweight: open print dialog for the ops console (user can Save as PDF / screenshot).
    // True canvas capture of map tiles would need html2canvas; avoided to keep deps zero.
    window.print();
}

function applyTheme(mode) {
    const light = mode === "light";
    document.body.classList.toggle("theme-light", light);
    try {
        localStorage.setItem("mcgs_theme", light ? "light" : "dark");
    } catch (e) { /* ignore */ }
    const sel = document.getElementById("settingTheme");
    if (sel) sel.value = light ? "light" : "dark";
}

function toggleTheme() {
    applyTheme(document.body.classList.contains("theme-light") ? "dark" : "light");
}

function toggleFullscreen() {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(function () {});
        document.body.classList.add("ops-fullscreen");
    } else {
        document.exitFullscreen().catch(function () {});
        document.body.classList.remove("ops-fullscreen");
    }
}

function toggleSettings(force) {
    const panel = document.getElementById("settingsPanel");
    if (!panel) return;
    if (force === true) panel.hidden = false;
    else if (force === false) panel.hidden = true;
    else panel.hidden = !panel.hidden;
}

function scrollToPanel(className) {
    const el = document.querySelector("." + className);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function wirePhaseGControls() {
    const mapBtn = function (id, fn) {
        const el = document.getElementById(id);
        if (el) el.addEventListener("click", fn);
    };
    mapBtn("btnFullscreen", toggleFullscreen);
    mapBtn("btnTheme", toggleTheme);
    mapBtn("btnExportCsv", exportTelemetryCsv);
    mapBtn("btnExportPdf", exportMissionReport);
    mapBtn("btnScreenshot", takeScreenshot);
    mapBtn("btnSettings", function () { toggleSettings(); });
    mapBtn("btnSettingsClose", function () { toggleSettings(false); });

    document.querySelectorAll(".ops-nav-link[data-scroll]").forEach(function (a) {
        a.addEventListener("click", function (ev) {
            ev.preventDefault();
            scrollToPanel(a.getAttribute("data-scroll"));
        });
    });

    const themeSel = document.getElementById("settingTheme");
    if (themeSel) {
        themeSel.addEventListener("change", function () {
            applyTheme(themeSel.value);
        });
    }
    const animSel = document.getElementById("settingAnim");
    if (animSel) {
        animSel.addEventListener("change", function () {
            document.body.classList.toggle("no-anim", animSel.value === "off");
            try {
                localStorage.setItem("mcgs_anim", animSel.value);
            } catch (e) { /* ignore */ }
        });
    }

    // Restore prefs
    try {
        const t = localStorage.getItem("mcgs_theme");
        if (t === "light") applyTheme("light");
        const a = localStorage.getItem("mcgs_anim");
        if (a === "off") {
            document.body.classList.add("no-anim");
            if (animSel) animSel.value = "off";
        }
    } catch (e) { /* ignore */ }

    document.addEventListener("keydown", function (ev) {
        if (ev.target && (ev.target.tagName === "INPUT" || ev.target.tagName === "TEXTAREA" || ev.target.tagName === "SELECT")) {
            return;
        }
        const k = ev.key;
        if (k === "F" || k === "f") {
            ev.preventDefault();
            toggleFullscreen();
        } else if (k === "T" || k === "t") {
            toggleTheme();
        } else if (k === "C" || k === "c") {
            exportTelemetryCsv();
        } else if (k === "S" || k === "s") {
            takeScreenshot();
        } else if (k === ",") {
            toggleSettings();
        } else if (k === "Escape") {
            toggleSettings(false);
        } else if (k >= "1" && k <= "7") {
            const panels = [
                "panel-fleet",
                "panel-map",
                "panel-charts",
                "panel-table",
                "panel-subsystems",
                "panel-commands",
                "panel-timeline",
            ];
            scrollToPanel(panels[Number(k) - 1]);
        }
    });
}


async function initDashboard() {
    let config;
    try {
        const response = await fetch(`${BACKEND_ORIGIN}/config`);
        config = await response.json();
    } catch (error) {
        console.error("Failed to load backend configuration:", error);
        return;
    }

    // Create Chart.js plots only after config succeeds and layout can settle.
    // Must run before bootstrapFleet() so the first history replay can paint.
    scheduleTelemetryChartInit();
    wireHistoricalReplayControls();
    wireTimeSliderControls();
    wirePhaseGControls();

    // Subsystem Health panel rows must exist before any telemetry arrives
    // (bootstrapFleet below, or the first WebSocket message), since
    // updateSubsystemHealthPanel() only updates existing badge elements —
    // it doesn't create them.
    buildSubsystemHealthRows(config.subsystems);
    // Command Uplink functions (see above) are top-level, not nested in
    // this function, so they read `config` through this module-level copy
    // rather than a closure. Must be set before bootstrapFleet() below,
    // since satellite auto-selection (see getOrCreateFleetEntry) calls
    // refreshCommandUplinkPanel() as soon as the first satellite is seen.
dashboardConfig = config;
    // Mission Clock: Update Rate reflects the real backend telemetry
    // sample cadence (GET /config's update_rate), not a fabricated
    // simulator speed multiplier.
    {
        const updateRateEl = document.getElementById("mcUpdateRate");
        if (updateRateEl) {
            const rate = Number(config.update_rate);
            updateRateEl.textContent =
                Number.isFinite(rate) && rate > 0
                    ? `1 SAMPLE / ${rate}s`
                    : "---";
            if (Number.isFinite(rate) && rate > 0) {
                connExpectedIntervalSec = rate;
            }
        }
    }
    startConnectionMonitor();
    // =========================
    // WebSocket Connection
    // =========================
    const socket = new WebSocket(config.websocket_url);

    // Reflect connecting state until onopen fires.
    wsConnected = false;
    {
        const connectionEl = document.getElementById("mhConnection");
        if (connectionEl) {
            connectionEl.textContent = "CONNECTING";
            connectionEl.className = "mh-value connecting";
        }
        const sourceEl = document.getElementById("mhSource");
        if (sourceEl) {
            sourceEl.textContent = "---";
            sourceEl.className = "mh-value offline";
        }
    }

    socket.onopen = () => {
        console.log(`Connected to ${config.project_name}`);
        wsConnected = true;
        updateMissionHeader();
        renderConnectionMonitor();
    };
    socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "telemetry") {
            updateDashboard(message);
            return;
        }
        if (message.type === "command_update") {
            handleCommandUpdate(message);
            return;
        }
        console.warn("Unknown WebSocket message type:", message);
    };
    socket.onclose = () => {
        console.log("Disconnected from Mission Control");
        wsConnected = false;
        updateMissionHeader();
        renderConnectionMonitor();
    };
    socket.onerror = () => {
        // onclose usually follows; still clear CONNECTING if the handshake fails.
        wsConnected = false;
        updateMissionHeader();
        renderConnectionMonitor();
    };
    // =========================
    // Bootstrap fleet state
    // =========================
    async function bootstrapFleet() {
        try {
            // Using the existing, general-purpose /telemetry/history
            // endpoint as a pragmatic multi-satellite bootstrap: fetch a
            // reasonably large recent window (no satellite_id filter) and
            // let updateDashboard() reduce it to "latest per satellite"
            // client-side, in order.
            //
            // This is NOT the ideal long-term API for this. A dedicated
            // fleet-summary endpoint — one row per satellite, via a
            // database-side "latest per group" query — would scale
            // correctly to a larger or faster-reporting fleet without
            // needing to guess a large-enough limit. At 3 satellites
            // reporting every few seconds, a modest limit reliably covers
            // all of them, so building that endpoint now would be
            // speculative for the fleet size this project actually has.
            const response = await fetch(
                `${config.api_url}/telemetry/history?limit=60`
            );
            const records = await response.json();
            if (!Array.isArray(records)) {
                return;
            }
            // Records arrive newest-first; replay oldest-first so chart
            // history (and the Mission Timeline, see pushTimelineEvents)
            // builds in the right order and the true latest sample per
            // satellite ends up as each entry's current state.
            records
                .slice()
                .reverse()
                .forEach((telemetry) => updateDashboard(telemetry, true));
        } catch (error) {
            console.error("Failed to load fleet history:", error);
        }
    }
    bootstrapFleet();
    // Loads the persistent mission event history (see
    // backend/app/core/events.py) so anomalies from before this page
    // loaded — including ones from a previous browser session or before a
    // backend restart — are still visible in the Mission Timeline. Must
    // run after buildSubsystemHealthRows() above (already satisfied,
    // since that runs earlier in this function) since bootstrapEvents
    // doesn't depend on it directly, but does depend on `config` for the
    // API origin, same as bootstrapFleet().
    bootstrapEvents(config);
    // =========================
    // Predicted orbit bootstrap + refresh
    // =========================
    // Fetched once here at startup, then re-fetched every 30 seconds to
    // match the backend's CACHE_TTL_SECONDS (see
    // backend/app/routers/orbit.py) — polling more often than that would
    // just re-request the same cached response.
    async function refreshOrbitTracks() {
        try {
            const response = await fetch(`${config.api_url}/orbit/tracks`);
            const data = await response.json();
            for (const [satelliteId, track] of Object.entries(data.tracks)) {
                updatePredictedOrbit(satelliteId, track);
            }
        } catch (error) {
            console.error("Failed to load predicted orbit tracks:", error);
        }
    }
    refreshOrbitTracks();
    setInterval(refreshOrbitTracks, 30000);
}
initDashboard();
