"""

In-memory simulated satellite state.

This module holds the mutable, per-satellite state that commands (see

backend/app/core/commands.py) act on and that

backend/simulator/telemetry_generator.py reads when building each

telemetry packet — so a command's effect is genuinely visible in

subsequent telemetry, not just recorded in the `commands` table.

Deliberately in-memory, not persisted to the database: this is the

*current* simulated state of a running satellite, conceptually the same

kind of thing as backend/simulator/orbit_propagator.py's live orbital

position — it exists only while the backend process is running, and

restarting the backend resets every satellite back to its defaults, the

same way the simulator's orbital phase offsets already do. The persistent,

durable record of *what was commanded and when* lives in the `commands`

table (backend/app/models/command.py) instead; this module and that table

deliberately serve different purposes and are not meant to be the same

thing.

Not the same concept as health status:

`OperatingMode` (NOMINAL/SAFE) is what an operator commanded. `HealthStatus`

(Nominal/Warning/Critical — backend/app/core/health_status.py) is what

subsystems are currently reporting. A satellite can be commanded into SAFE

mode while every subsystem still reports Nominal health, or stay in

NOMINAL mode while a subsystem reports Critical — the two are independent

on purpose, and this module never reads or writes HealthStatus.

"""

import asyncio

from enum import StrEnum

from backend.simulator.fleet import SATELLITE_IDS

class OperatingMode(StrEnum):

    """The satellite's commanded operating mode. See the module docstring for why this is a separate concept from HealthStatus."""

    NOMINAL = "NOMINAL"

    SAFE = "SAFE"

class ComputerState(StrEnum):

    """

    Transient flight-computer state during a simulated RESTART_COMPUTER

    command. NORMAL the rest of the time; briefly RESTARTING while a

    restart is in progress (see backend/app/core/commands.py), then back

    to NORMAL — this project deliberately has no permanent failure state

    for a simulated restart.

    """

    NORMAL = "NORMAL"

    RESTARTING = "RESTARTING"

class SatelliteState:

    """Mutable simulated state for one satellite."""

    def __init__(self):

        self.operating_mode: OperatingMode = OperatingMode.NOMINAL

        # Satellites launch with the payload off, awaiting an explicit

        # ENABLE_PAYLOAD command — this default is what makes that command

        # observably do something, rather than being a no-op confirming an

        # already-true state.

        self.payload_enabled: bool = False

        self.computer_state: ComputerState = ComputerState.NORMAL

    def as_dict(self) -> dict:

        return {

            "operating_mode": self.operating_mode,

            "payload_enabled": self.payload_enabled,

            "computer_state": self.computer_state,

        }

# One SatelliteState (and one asyncio.Lock guarding mutations to it) per

# satellite in the fleet, keyed by satellite_id — built once, at import

# time, from the same SATELLITE_IDS every other part of this project

# already treats as the single source of truth for "which satellites

# exist" (backend/simulator/fleet.py).

_STATE: dict[str, SatelliteState] = {

    satellite_id: SatelliteState() for satellite_id in SATELLITE_IDS

}

_LOCKS: dict[str, asyncio.Lock] = {

    satellite_id: asyncio.Lock() for satellite_id in SATELLITE_IDS

}

def get_state(satellite_id: str) -> SatelliteState:

    """

    Returns the mutable SatelliteState for `satellite_id`.

    Raises KeyError for a satellite_id outside the configured fleet —

    callers (backend/app/routers/commands.py) are expected to validate

    satellite_id against SATELLITE_IDS themselves before calling this

    (returning a proper 404 to the API caller), so a KeyError reaching

    here means that validation was skipped, not a normal, user-facing

    error path.

    """

    return _STATE[satellite_id]

def get_lock(satellite_id: str) -> asyncio.Lock:

    """

    Returns the asyncio.Lock guarding `satellite_id`'s state. Held only

    around the actual read-modify-write of that state (see

    backend/app/core/commands.py), never across the multi-second simulated

    uplink delay between command lifecycle stages — holding it that long

    would serialize unrelated commands for the same satellite for no

    reason, when only the moment of mutation itself needs protection

    against two commands for the same satellite executing concurrently.

    """

    return _LOCKS[satellite_id]