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

// Assigned by order of first appearance, not by satellite ID, so this

// file never hardcodes which satellite gets which color.

const SATELLITE_COLORS = ["#00E5FF", "#FFC107", "#E040FB"];

const DEFAULT_SATELLITE_COLOR = "#9E9E9E";

function getSatelliteColor(index) {

    return SATELLITE_COLORS[index] ?? DEFAULT_SATELLITE_COLOR;

}

function statusClass(status) {

    if (status === "Nominal") return "nominal";

    if (status === "Warning") return "warning";

    if (status === "Critical") return "critical";

    return "";

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

    if (entry.latest) {

        updateDetailPanel(entry.latest);

        updateSubsystemHealthPanel(entry.latest);

    }

    renderChartsFor(entry);

}

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

    statusEl.textContent = telemetry.status;

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

    // Predicted ground track per satellite — dashed, and always visible

    // regardless of which satellite is currently selected (see

    // updatePredictedOrbit below). A separate layer from `trail` above,

    // since the two represent different things (recorded past vs.

    // propagated future) and should never visually merge.

    const predictedTrail = L.polyline([], {

        color: color,

        weight: 2,

        dashArray: "6, 6",

        opacity: 0.7,

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

        badge.textContent = state || "---";

        badge.className = "subsystem-badge " + (state ? statusClass(state) : "");

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

// Detail panel (Live Telemetry card) — selector-scoped

// =========================

function updateDetailPanel(telemetry) {

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

    const previousTelemetry = entry.latest;

    entry.latest = telemetry;

    updateFleetCard(entry, telemetry);

    updateMapMarker(entry, telemetry);

    updateAlarmVisuals(entry, telemetry);

    updateAlarmBanner();

    pushChartHistory(entry, telemetry);

    pushTimelineEvents(telemetry, previousTelemetry);

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