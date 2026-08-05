from datetime import datetime, UTC

from enum import StrEnum

from sqlalchemy import Column

from sqlalchemy import Integer

from sqlalchemy import String

from sqlalchemy import Boolean

from sqlalchemy import DateTime

from sqlalchemy.orm import Session

from backend.app.database.database import Base

from backend.simulator.fleet import SATELLITE_IDS

class OperatingMode(StrEnum):

    """

    The satellite's commanded operating mode. NOT the same concept as

    HealthStatus (Nominal/Warning/Critical —

    backend/app/core/health_status.py): `OperatingMode` is what an

    operator commanded; `HealthStatus` is what subsystems are currently

    reporting. A satellite can be commanded into SAFE mode while every

    subsystem still reports Nominal health, or stay in NOMINAL mode while

    a subsystem reports Critical — the two are independent on purpose.

    """

    NOMINAL = "NOMINAL"

    SAFE = "SAFE"

class ComputerState(StrEnum):

    """

    Transient flight-computer state during a simulated RESTART_COMPUTER

    command (see backend/app/core/commands.py). NORMAL the rest of the

    time; briefly RESTARTING while a restart is in progress, then back to

    NORMAL — this project deliberately has no permanent failure state for

    a simulated restart.

    """

    NORMAL = "NORMAL"

    RESTARTING = "RESTARTING"

class SatelliteState(Base):

    """

    The current simulated state of one satellite — the SHARED source of

    truth between the FastAPI backend process (which mutates it when a

    command executes — see backend/app/core/commands.py) and the

    telemetry-generator process (which reads it, over HTTP via

    `GET /satellite-state/{satellite_id}`, before building each telemetry

    packet — see backend/simulator/telemetry_generator.py).

    This project runs those two as SEPARATE OS processes (per their own

    `python -m uvicorn ...` / `python -m backend.simulator...` commands) —

    there is no shared Python memory between them. A plain in-process

    dict, as an earlier version of this feature used, is invisible across

    that process boundary: a command would mutate the backend process's

    copy while the simulator kept reading its own, and the command's

    effect would never reach telemetry. This table — the one thing both

    processes actually share, the same SQLite file — is what fixes that.

    One row per satellite, keyed uniquely by `satellite_id`

    (`ensure_satellite_states()` below creates a default row, idempotently,

    for every satellite in SATELLITE_IDS the first time this table is

    empty for that satellite — see backend/app/main.py, which calls it

    once at backend startup).

    Distinct from the persistent `commands` table

    (backend/app/models/command.py): that table is a durable *history* of

    every command ever sent, growing forever; this table is the satellite's

    *current* state, exactly one row per satellite, overwritten in place —

    the two intentionally serve different purposes.

    """

    __tablename__ = "satellite_state"

    id = Column(

        Integer,

        primary_key=True,

        index=True

    )

    satellite_id = Column(

        String,

        unique=True,

        nullable=False,

        index=True

    )

    operating_mode = Column(

        String,

        nullable=False,

        default=OperatingMode.NOMINAL

    )

    payload_enabled = Column(

        Boolean,

        nullable=False,

        default=False

    )

    computer_state = Column(

        String,

        nullable=False,

        default=ComputerState.NORMAL

    )

    updated_at = Column(

        DateTime,

        nullable=False

    )

def ensure_satellite_states(db: Session) -> None:

    """

    Ensures every satellite in SATELLITE_IDS (backend/simulator/fleet.py)

    has a `satellite_state` row, creating one with defaults — NOMINAL

    operating mode, payload disabled, computer NORMAL — for any that don't

    already have one. Idempotent: called once at backend startup (see

    backend/app/main.py), but safe to call again on every subsequent

    restart — an existing row for a satellite is left completely

    untouched, so a restart never resets a satellite's commanded state

    back to defaults.

    """

    for satellite_id in SATELLITE_IDS:

        existing = (

            db.query(SatelliteState)

            .filter(SatelliteState.satellite_id == satellite_id)

            .first()

        )

        if existing is not None:

            continue

        db.add(

            SatelliteState(

                satellite_id=satellite_id,

                operating_mode=OperatingMode.NOMINAL,

                payload_enabled=False,

                computer_state=ComputerState.NORMAL,

                updated_at=datetime.now(UTC),

            )

        )

    db.commit()