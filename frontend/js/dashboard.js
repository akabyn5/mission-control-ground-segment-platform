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
        return null;
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
    refreshCommandUplinkPanel(satelliteId);
    if (entry.latest) {
        updateDetailPanel(entry.latest);
        updateSubsystemHealthPanel(entry.latest);
    }
    renderChartsFor(entry);
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
}

// =========================
// Mission Clock
// =========================
// Compact aerospace instrumentation strip:
//   UTC            — browser clock, forced to UTC (not local TZ)
//   Mission Elapsed — T+ from dashboard session start (no backend
//                     mission-start field exists today)
//   Sim Speed      — static 1.0× REALTIME; simulator does not expose
//                     a variable speed over the public API
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
// Each chart shows exactly one line: the currently-selected satellite's
// data. Every satellite's own history keeps accumulating in the fleet Map
// even while not displayed (see pushChartHistory/renderChartsFor below),
// so switching the selector back to a previously-viewed satellite shows
// its real trend, not a reset chart.
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
function pushChartHistory(entry, telemetry) {
    const label = new Date(telemetry.timestamp).toLocaleTimeString();
    const fields = [
        ["batteryHistory", telemetry.battery],
        ["temperatureHistory", telemetry.temperature],
        ["cpuHistory", telemetry.cpu_load],
    ];
    for (const [key, value] of fields) {
        entry[key].labels.push(label);
        entry[key].values.push(value);
        // Keep only the latest 20 samples, per satellite.
        if (entry[key].labels.length > 20) {
            entry[key].labels.shift();
            entry[key].values.shift();
        }
    }
}
function renderChartsFor(entry) {
    batteryChart.data.labels = entry.batteryHistory.labels;
    batteryChart.data.datasets[0].data = entry.batteryHistory.values;
    batteryChart.update();
    temperatureChart.data.labels = entry.temperatureHistory.labels;
    temperatureChart.data.datasets[0].data = entry.temperatureHistory.values;
    temperatureChart.update();
    cpuChart.data.labels = entry.cpuHistory.labels;
    cpuChart.data.datasets[0].data = entry.cpuHistory.values;
    cpuChart.update();
}
// =========================
// Fleet Summary Cards
// =========================
function createFleetCard(satelliteId, color) {
    const card = document.createElement("div");
    card.className = "status-card";
    card.style.borderLeftColor = color;
    card.dataset.satelliteId = satelliteId;
    card.innerHTML = `
        <h3>${satelliteId}</h3>
        <span class="fleet-status">---</span>
        <div class="fleet-metrics">
            <span class="fleet-battery">Battery: ---</span>
            <span class="fleet-signal">Signal: ---</span>
        </div>
        <div class="fleet-location">---</div>
        <div class="fleet-updated">---</div>
    `;
    card.addEventListener("click", () => showSatellite(satelliteId));
    document.getElementById("fleetSummary").appendChild(card);
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
    entry.card.querySelector(".fleet-battery").textContent =
        "Battery: " + telemetry.battery.toFixed(1) + "%";
    entry.card.querySelector(".fleet-signal").textContent =
        "Signal: " + telemetry.signal_strength.toFixed(1) + "%";
    entry.card.querySelector(".fleet-location").textContent =
        formatLocation(telemetry.latitude, telemetry.longitude);
    entry.card.querySelector(".fleet-updated").textContent =
        "Updated " + new Date(telemetry.timestamp).toLocaleTimeString();
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
// Predicted orbit overlay (GET /orbit/tracks)
// =========================
// Rendering is intentionally independent of `selectedSatelliteId` — every
// satellite's predicted track stays visible on the map no matter which
// one is selected in the dropdown, unlike the detail panel/charts, which
// are selector-scoped.
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
    for (const entry of fleet.values()) {
        const level = highestAlarmLevel(entry.activeAlarms);
        if (level === "Critical") {
            worstLevel = "Critical";
            worstAlarm = entry.activeAlarms.find((alarm) => alarm.level === "Critical");
            break; // Critical always wins; no need to keep scanning the fleet.
        }
        if (level === "Warning" && worstLevel !== "Critical") {
            worstLevel = "Warning";
            worstAlarm = entry.activeAlarms.find((alarm) => alarm.level === "Warning");
        }
    }
    alarmBanner.classList.remove("visible", "level-warning", "level-critical", "alarm-flash");
    if (worstLevel === null) {
        return;
    }
    alarmBanner.textContent = worstAlarm.message;
    alarmBanner.classList.add("visible", "level-" + worstLevel.toLowerCase());
    if (worstLevel === "Critical") {
        alarmBanner.classList.add("alarm-flash");
    }
}
// =========================
// Subsystem Health panel — selector-scoped
// =========================
// Replaces the old single "Status" row in the Live Telemetry card. Rows
// are built once GET /config resolves (see buildSubsystemHealthRows,
// called from initDashboard below) from the ordered subsystem list the
// backend returns — nothing in this file hardcodes "power"/"thermal"/etc.
const subsystemHealthContainer = document.getElementById("subsystemHealth");
// The ordered {key, label} list from GET /config. Used both to build the
// panel below AND to detect subsystem transitions for the Mission
// Timeline (see pushTimelineEvents) — the one place in this file that
// knows the subsystem list, so nothing else has to.
let SUBSYSTEM_LIST = [];
// {key: badgeElement}, built by buildSubsystemHealthRows() alongside
// SUBSYSTEM_LIST above, so updateSubsystemHealthPanel() doesn't need to
// re-query the DOM on every telemetry sample.
let subsystemBadges = {};
function buildSubsystemHealthRows(subsystems) {
    SUBSYSTEM_LIST = subsystems || [];
    subsystemHealthContainer.innerHTML = "";
    subsystemBadges = {};
    for (const subsystem of SUBSYSTEM_LIST) {
        const row = document.createElement("div");
        row.className = "subsystem-row";
        row.innerHTML = `
            <span class="subsystem-name">${subsystem.label}</span>
            <span class="subsystem-badge">---</span>
        `;
        subsystemHealthContainer.appendChild(row);
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
    updateFleetCard(entry, telemetry);
    updateMapMarker(entry, telemetry);
    updateAlarmVisuals(entry, telemetry);
    updateAlarmBanner();
    pushChartHistory(entry, telemetry);
    pushTimelineEvents(telemetry);
    if (telemetry.satellite_id === selectedSatelliteId) {
        updateDetailPanel(telemetry);
        updateSubsystemHealthPanel(telemetry);
        renderChartsFor(entry);
        if (trackingEnabled && !isBootstrap) {
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
async function initDashboard() {
    let config;
    try {
        const response = await fetch(`${BACKEND_ORIGIN}/config`);
        config = await response.json();
    } catch (error) {
        console.error("Failed to load backend configuration:", error);
        return;
    }
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
    };
    socket.onerror = () => {
        // onclose usually follows; still clear CONNECTING if the handshake fails.
        wsConnected = false;
        updateMissionHeader();
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
