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


def generate_telemetry():

    position = get_current_position()

    return {

        "satellite_id": settings.SATELLITE_NAME,

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


def send_telemetry():
    telemetry = generate_telemetry()

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

        send_telemetry()

        time.sleep(settings.UPDATE_RATE)