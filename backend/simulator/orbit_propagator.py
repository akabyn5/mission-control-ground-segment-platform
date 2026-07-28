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


def get_current_position():
    """
    Returns the current orbital state.
    """

    t = ts.now()

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