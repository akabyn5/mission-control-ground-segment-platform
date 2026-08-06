"""

RETIRED.

This module used to hold an in-process, module-level dict as the

"current simulated satellite state." That design is broken for this

project's actual deployment: the FastAPI backend

(`python -m uvicorn backend.app.main:app`) and the telemetry generator

(`python -m backend.simulator.telemetry_generator`) run as separate OS

processes with no shared Python memory, so a command mutating this

module's state in the backend process would never be visible to the

telemetry generator reading its own, separate copy of this module in its

own process. A command's effect would be recorded but never actually

show up in telemetry.

The current, correct implementation is a SQLite-backed table — the one

thing both processes genuinely share, the same database file — instead of

in-process memory:

- `backend/app/models/satellite_state.py` — the `SatelliteState` model and

  `ensure_satellite_states()`.

- `backend/app/core/commands.py` — the only code that mutates it, always

  through the database, never through a Python object shared across a

  process boundary that doesn't exist.

- `backend/simulator/telemetry_generator.py`'s `fetch_satellite_state()` —

  how the telemetry-generator process reads it: over HTTP, via

  `GET /satellite-state/{satellite_id}`, exactly like any other client of

  this API.

Nothing in this project imports this module anymore. It is kept only so

that an old import of it fails loudly and immediately, pointing here,

rather than silently resurrecting the cross-process bug it used to cause.

If your checkout still has this file: delete it. This stub exists to be

removed, not to be built on.

"""

raise ImportError(

    "backend.simulator.satellite_state is retired — it was an in-memory "

    "state store that cannot work across the backend/simulator process "

    "boundary. Use backend.app.models.satellite_state.SatelliteState "

    "(the database-backed table) instead. See this module's own "

    "docstring for the full explanation. Delete this file from your "

    "checkout; nothing in this project imports it anymore."

)