import numpy as np

from skyfield.api import EarthSatellite
from skyfield.api import load

from backend.simulator.tle import (
    LINE1,
    LINE2,
    OBJECT_NAME,
)

ts = load.timescale()

satellite = EarthSatellite(
    LINE1,
    LINE2,
    OBJECT_NAME,
    ts
)

# Defaults used by get_predicted_track() when the caller doesn't need a
# different horizon/resolution. This module stays fleet-agnostic — it
# knows nothing about satellite IDs or how many satellites exist — so
# these are just the propagation defaults, not fleet configuration.
DEFAULT_HORIZON_MINUTES = 90

DEFAULT_STEP_MINUTES = 1


def get_current_position(offset_minutes=0):
    """
    Returns the orbital state `offset_minutes` minutes from now.

    The optional offset lets multiple simulated satellites share the same
    underlying orbit (see backend/simulator/tle.py) while appearing at
    different points along it, instead of every satellite reporting an
    identical position. Defaults to 0, which preserves the exact original
    single-satellite behavior for any other caller.
    """

    t = ts.now() + offset_minutes / (24 * 60)

    geocentric = satellite.at(t)

    subpoint = geocentric.subpoint()

    latitude = subpoint.latitude.degrees

    longitude = subpoint.longitude.degrees

    altitude = subpoint.elevation.km

    velocity = geocentric.velocity.km_per_s

    speed = (
        velocity[0] ** 2
        + velocity[1] ** 2
        + velocity[2] ** 2
    ) ** 0.5

    return {
        "latitude": latitude,
        "longitude": longitude,
        "altitude": altitude,
        "velocity": speed,
    }


def get_predicted_track(
    offset_minutes=0,
    horizon_minutes=DEFAULT_HORIZON_MINUTES,
    step_minutes=DEFAULT_STEP_MINUTES,
):
    """
    Returns a predicted ground track starting `offset_minutes` minutes from
    now and extending `horizon_minutes` minutes into the future, sampled
    every `step_minutes` minutes.

    Like get_current_position(), `offset_minutes` lets multiple simulated
    satellites share the same underlying orbit while predicting forward
    from different points along it — this function has no knowledge of
    satellite IDs or fleet configuration; the caller is responsible for
    supplying the correct offset for whichever satellite it's asking about.

    Propagation is vectorized: every sample point is computed in a single
    `satellite.at(times)` call over a Skyfield Time array, rather than one
    `satellite.at(t)` call per point, so the cost of predicting a full
    track does not scale linearly with the number of Python-level calls.

    Returns a list of dictionaries, ordered from `offset_minutes` to
    `offset_minutes + horizon_minutes`, each containing only:
        {
            "latitude": ...,
            "longitude": ...,
        }
    Altitude and velocity are intentionally omitted — this function is
    used to draw a predicted ground track on a 2D map, which only needs
    the sub-satellite point.
    """

    minute_offsets = np.arange(
        0,
        horizon_minutes + step_minutes,
        step_minutes,
    )

    t0 = ts.now()

    times = ts.tt_jd(t0.tt + (offset_minutes + minute_offsets) / (24 * 60))

    geocentric = satellite.at(times)

    subpoint = geocentric.subpoint()

    latitudes = subpoint.latitude.degrees

    longitudes = subpoint.longitude.degrees

    return [
        {
            "latitude": float(latitude),
            "longitude": float(longitude),
        }
        for latitude, longitude in zip(latitudes, longitudes)
    ]