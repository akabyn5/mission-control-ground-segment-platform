import random

import time

import requests

from datetime import datetime, UTC

from backend.app.core.config import settings

from backend.app.core.health_status import SUBSYSTEMS

from backend.app.core.logging_config import get_logger

from backend.simulator.fleet import (
    ORBIT_PHASE_STEP_MINUTES,
    SATELLITE_IDS,
    SATELLITE_OFFSETS,
)

from backend.simulator.orbit_propagator import get_current_position

logger = get_logger(__name__)

# Base REST origin comes from centralized settings; only the fixed,

# non-configurable path ("/telemetry") is appended here.

TELEMETRY_ENDPOINT = f"{settings.API_URL}/telemetry"

# Rough weights for independently rolling each subsystem's health state —

# ~90% Nominal, ~8% Warning, ~2% Critical, matching real ground-software

# expectations that most subsystems are healthy most of the time.

# random.choices() below normalizes these itself, so they don't need to

# sum to exactly 100.

SUBSYSTEM_STATE_WEIGHTS = {

    "Nominal": 90,

    "Warning": 8,

    "Critical": 2,

}

def generate_subsystem_states():

    """

    Rolls an independent health state for each subsystem in SUBSYSTEMS

    (see backend/app/core/health_status.py), using

    SUBSYSTEM_STATE_WEIGHTS. Each subsystem is rolled separately — not

    correlated with each other or with the numeric metrics (battery,

    temperature, signal_strength, cpu_load) generated below — so it's

    entirely possible, and realistic for this demo, for exactly one

    subsystem to be Warning/Critical while the rest (and every numeric

    metric) stay nominal. This independence is a disclosed simplification:

    a real satellite's power subsystem failing would obviously also affect

    its battery reading; backend/app/core/alarms.py is written to handle

    that correlation not holding here, by evaluating the numeric and

    subsystem signals for the same concern independently and merging

    whichever one(s) actually fire (see METRIC_SUBSYSTEM_OVERLAP there).

    """

    states = list(SUBSYSTEM_STATE_WEIGHTS.keys())

    weights = list(SUBSYSTEM_STATE_WEIGHTS.values())

    return {

        subsystem: random.choices(states, weights=weights, k=1)[0]

        for subsystem in SUBSYSTEMS

    }

def generate_telemetry(satellite_id):

    """

    Build one telemetry sample for the given satellite. All fleet members

    share the same underlying orbit, offset by their position in

    SATELLITE_IDS (see ORBIT_PHASE_STEP_MINUTES above) so they appear at

    distinct points along the ground track instead of on top of each other.

    Deliberately has no "status" key: the backend computes the overall

    status from `subsystems` (see health_status.worst_status(), called

    from backend/app/routers/telemetry.py) — the simulator, like any other

    telemetry producer, reports only per-subsystem health, never an

    overall status directly. See the module docstring in

    backend/app/schemas/telemetry.py for why.

    """

    offset_minutes = SATELLITE_OFFSETS[satellite_id]

    position = get_current_position(offset_minutes)

    return {

        "satellite_id": satellite_id,

        "latitude": round(position["latitude"], 4),

        "longitude": round(position["longitude"], 4),

        "altitude": round(position["altitude"], 2),

        "velocity": round(position["velocity"], 3),

        "battery": round(random.uniform(95, 100), 2),

        "temperature": round(random.uniform(18, 30), 2),

        "signal_strength": round(random.uniform(80, 100), 2),

        "cpu_load": round(random.uniform(10, 60), 2),

        "subsystems": generate_subsystem_states(),

        "timestamp": datetime.now(UTC).isoformat()

    }

def send_telemetry(satellite_id):

    telemetry = generate_telemetry(satellite_id)

    try:

        response = requests.post(

            TELEMETRY_ENDPOINT,

            json=telemetry

        )

    except requests.exceptions.RequestException:

        # Covers connection errors, timeouts, DNS failures, etc.

        logger.exception(

            "Failed to send telemetry for %s (request error)",

            telemetry["satellite_id"]

        )

        return

    if response.status_code == 200:

        logger.info(

            "Telemetry sent successfully (satellite=%s, status_code=%s)",

            telemetry["satellite_id"],

            response.status_code

        )

    else:

        logger.error(

            "Telemetry request failed (satellite=%s, status_code=%s, response=%s)",

            telemetry["satellite_id"],

            response.status_code,

            response.text

        )

if __name__ == "__main__":

    while True:

        # One send per satellite, per tick — sequential, not concurrent,

        # so this stays the same simple loop shape as before. Real network

        # I/O time between each POST naturally gives every packet a

        # distinct timestamp (verified empirically, not just assumed).

        for satellite_id in SATELLITE_IDS:

            send_telemetry(satellite_id)

        time.sleep(settings.UPDATE_RATE)