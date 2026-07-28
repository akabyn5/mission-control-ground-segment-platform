"""
TLE definitions used by the orbit propagator.

Note: the satellite's identifier (what appears in telemetry payloads) is
now sourced from `settings.SATELLITE_NAME` in backend/app/core/config.py,
not from a constant here. This file is left holding only orbital/domain
data — which physical object's orbit is being simulated — which is not
deployment configuration and is out of scope for the config refactor.
"""

ORBIT_SOURCE = "ISS TLE"

OBJECT_NAME = "ISS (ZARYA)"

LINE1 = (
    "1 25544U 98067A   26195.53402778  .00016547  "
    "00000+0  30000-3 0  9992"
)

LINE2 = (
    "2 25544  51.6394 181.9473 0004205  "
    "67.8474  35.4378 15.50393274483257"
)