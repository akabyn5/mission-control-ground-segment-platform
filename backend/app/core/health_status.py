"""

Shared health-status vocabulary for the Mission Control Ground Segment

Platform.

Every part of the project that talks about subsystem or overall health —

the telemetry simulator, the Pydantic schemas, the alarm engine

(backend/app/core/alarms.py), and (via the values sent over the wire) the

frontend — imports the constants defined here instead of hardcoding the

strings "Nominal"/"Warning"/"Critical" or the five subsystem names

separately in multiple places. A typo like "critical" vs "Critical" in one

component would otherwise silently break comparisons and UI behavior

across the whole pipeline.

"""

from enum import StrEnum

class HealthStatus(StrEnum):

    """

    The three health states used everywhere in this project — subsystem

    health, computed overall satellite status, and alarm severity. A

    StrEnum (not a plain class of string constants) so Pydantic validates

    against exactly these three values and rejects anything else, while

    still behaving as an ordinary string everywhere it's used (JSON

    serialization, string comparisons, f-strings, dict keys).

    """

    NOMINAL = "Nominal"

    WARNING = "Warning"

    CRITICAL = "Critical"

# Canonical set of subsystems every telemetry packet reports on, and the

# order they're displayed in. A tuple (not a dict/set) because that display

# order matters — the frontend's Subsystem Health panel builds its rows

# from this exact list, received via GET /config (see

# backend/app/schemas/config.py), rather than hardcoding subsystem names.

SUBSYSTEMS = (

    "power",

    "thermal",

    "communications",

    "adcs",

    "payload",

)

# Human-readable label for each subsystem key. Spelled out explicitly

# rather than derived (e.g. via .capitalize()), since that would get

# "adcs" wrong ("Adcs" instead of "ADCS").

SUBSYSTEM_LABELS = {

    "power": "Power",

    "thermal": "Thermal",

    "communications": "Communications",

    "adcs": "ADCS",

    "payload": "Payload",

}

def worst_status(statuses) -> HealthStatus:

    """

    Given any iterable of HealthStatus values, returns the single worst one

    — Critical beats Warning beats Nominal.

    Used to roll up a satellite's five independent subsystem states into

    one overall status (see backend/simulator/telemetry_generator.py), and

    mirrored on the frontend (frontend/js/dashboard.js,

    computeOverallStatus()) for the fleet card badge — the two can't

    literally share code across the Python/JavaScript boundary, so that

    duplication is a deliberate, disclosed simplification rather than an

    oversight; see the comment at computeOverallStatus() for the same

    reasoning already applied elsewhere in this project (e.g.

    backend/simulator/fleet.py's ORBIT_PHASE_STEP_MINUTES).

    """

    statuses = list(statuses)

    if HealthStatus.CRITICAL in statuses:

        return HealthStatus.CRITICAL

    if HealthStatus.WARNING in statuses:

        return HealthStatus.WARNING

    return HealthStatus.NOMINAL