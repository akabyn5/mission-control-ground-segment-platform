"""
Fleet configuration for the simulated satellite constellation.

This is the single source of truth for "how many satellites, which IDs,
and how they're phased along the shared orbit." It contains no Skyfield
imports and no propagation logic — only fleet configuration — so both
backend/simulator/telemetry_generator.py and backend/app/routers/orbit.py
can import from it without either one owning the other's concerns.
"""

# The fleet this project simulates telemetry and orbit predictions for.
# This is the single source of truth for "how many satellites, and which
# IDs" — adding or removing one is a one-line change here; nothing else
# in the codebase needs to know the fleet size.
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