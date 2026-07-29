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