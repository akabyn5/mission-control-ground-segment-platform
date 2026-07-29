import random
import time

import requests

from datetime import datetime, UTC

from backend.app.core.config import settings
from backend.app.core.logging_config import get_logger
from backend.simulator.orbit_propagator import get_current_position

logger = get_logger(__name__)

# Base REST origin comes from centralized settings; only the fixed,
# non-configurable path ("/telemetry") is appended here.
TELEMETRY_ENDPOINT = f"{settings.API_URL}/telemetry"

# The fleet this simulator generates telemetry for. This is the single
# source of truth for "how many satellites, and which IDs" — adding or
# removing one is a one-line change here; nothing else in this file (or
# the send loop below) needs to know the fleet size.
SATELLITE_IDS = (
    "SD-CUBESAT-001",
    "SD-CUBESAT-002",
    "SD-CUBESAT-003",
)

# Minutes of orbital separation between consecutive satellites in
# SATELLITE_IDS (satellite N, 0-indexed, is evaluated N * this many
# minutes ahead along the same shared orbit). This is a deliberate,
# disclosed simplification for a fictional demo constellation — the
# relative phase is fixed, not physically evolving. Fabricating
# independent TLE data for two more fictional CubeSats would add real
# risk (malformed elements, silently wrong propagation) for a level of
# orbital realism this project has never modeled, even for the original
# satellite (which already rides the real ISS's real TLE as a stand-in).
ORBIT_PHASE_STEP_MINUTES = 30

# Explicit orbital offset assigned to each satellite.
# The values are derived from ORBIT_PHASE_STEP_MINUTES so changing the
# phase step automatically updates every satellite.
SATELLITE_OFFSETS = {
    satellite_id: index * ORBIT_PHASE_STEP_MINUTES
    for index, satellite_id in enumerate(SATELLITE_IDS)
}

def generate_telemetry(satellite_id):
    """
    Build one telemetry sample for the given satellite. All fleet members
    share the same underlying orbit, offset by their position in
    SATELLITE_IDS (see ORBIT_PHASE_STEP_MINUTES above) so they appear at
    distinct points along the ground track instead of on top of each other.
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

        "status": "Nominal",

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