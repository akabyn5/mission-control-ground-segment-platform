"""

Simulated command uplink execution.

This module is the single source of truth for "what happens when this

command executes." `backend/app/routers/commands.py` schedules

`run_command_lifecycle()` as a FastAPI background task immediately after

persisting a command's initial QUEUED row and returning `202 Accepted` —

it is NOT run inline within the request/response cycle (an earlier version

of this feature did that; see "Why a background task" below).

`run_command_lifecycle()` advances the command through SENT ->

ACKNOWLEDGED -> EXECUTED/FAILED, committing the `commands` row's status

after each stage and broadcasting a `"command_update"` WebSocket message

after each one, so the dashboard shows live progress without polling. At

the EXECUTED/FAILED stage it applies the command's effect to

`satellite_state` — the same SQLite-backed table

`backend/simulator/telemetry_generator.py` reads, over HTTP, before

building each telemetry packet, which is what makes a command's effect

actually show up in subsequent telemetry (see

backend/app/models/satellite_state.py's docstring for why that has to be

a shared database table rather than in-process Python state: the FastAPI

backend and the telemetry generator run as separate OS processes with no

shared memory).

Why a background task, not an inline `await`:

An earlier version of this endpoint ran this entire lifecycle inline,

inside the `POST /commands` request handler, keeping the HTTP connection

open for the full ~3 simulated seconds before responding. FastAPI's

`BackgroundTasks` (standard library — no Celery/Redis/Kafka needed) let

`POST /commands` persist the QUEUED row, return `202 Accepted`

immediately, and let this function keep running afterward, on the same

asyncio event loop — a better fit for "the operator sent a command, they

don't need to wait several seconds for a response" and closer to how a

real uplink API would behave (fire-and-forget with separate status

polling/push).

Why this function opens its own database session:

Background tasks scheduled via `BackgroundTasks` can outlive the request

that scheduled them; reusing that request's `Depends(get_db)` session here

would be relying on FastAPI's dependency-cleanup timing relative to

background-task completion, which is exactly the kind of subtle,

easy-to-get-wrong lifetime coupling this function avoids by simply

opening (and closing, in a `finally`) its own session instead.

"""

import asyncio

from datetime import datetime, UTC

from backend.app.core.config import settings

from backend.app.core.logging_config import get_logger

from backend.app.database.database import SessionLocal

from backend.app.models.command import Command, CommandStatus, CommandType

from backend.app.models.event import Event

from backend.app.models.satellite_state import ComputerState, OperatingMode, SatelliteState

from backend.app.websocket.connection_manager import manager

logger = get_logger(__name__)

# Human-readable event message per command type, used only for the

# terminal "Command" mission event (EXECUTED or FAILED) — see

# _finish()'s docstring for why intermediate stages don't get their own

# persisted event.

_EXECUTED_EVENT_MESSAGES = {

    CommandType.ENABLE_PAYLOAD: "Payload enabled",

    CommandType.RESTART_COMPUTER: "Flight computer restarted",

    CommandType.CHANGE_MODE: "Operating mode changed to {mode}",

    CommandType.ENTER_SAFE_MODE: "Satellite entered Safe Mode",

}

def _command_dict(command: Command) -> dict:

    """Plain-dict projection of a Command row, shared by every command_update broadcast below."""

    return {

        "id": command.id,

        "satellite_id": command.satellite_id,

        "command_type": command.command_type,

        "parameters": command.parameters,

        "status": command.status,

        "failure_reason": command.failure_reason,

        "created_at": command.created_at.isoformat(),

        "acknowledged_at": command.acknowledged_at.isoformat() if command.acknowledged_at else None,

        "executed_at": command.executed_at.isoformat() if command.executed_at else None,

    }

def _event_dict(event: Event) -> dict:

    """Plain-dict projection of an Event row, for embedding in a command_update broadcast."""

    return {

        "id": event.id,

        "satellite_id": event.satellite_id,

        "timestamp": event.timestamp.isoformat(),

        "event_type": event.event_type,

        "severity": event.severity,

        "message": event.message,

        "rule": event.rule,

        "subsystem": event.subsystem,

    }

async def _advance(command: Command, db, new_status: CommandStatus, **timestamp_fields) -> None:

    """

    Non-terminal stage transition (SENT, ACKNOWLEDGED): sets

    `command.status` and any given timestamp columns, commits, refreshes,

    and broadcasts the resulting state. See _finish() below for the

    terminal (EXECUTED/FAILED) case, which also attaches a mission event

    to the same broadcast instead of calling this function.

    """

    command.status = new_status

    for field, value in timestamp_fields.items():

        setattr(command, field, value)

    db.commit()

    db.refresh(command)

    await manager.broadcast({"type": "command_update", **_command_dict(command)})

async def _finish(command: Command, db, new_status: CommandStatus, **timestamp_fields) -> None:

    """

    Terminal stage transition (EXECUTED or FAILED): sets status/timestamps,

    commits, creates the one mission Event for this command's outcome (see

    backend/app/models/event.py), and broadcasts a SINGLE command_update

    message carrying both the final command state and that new event

    together — one broadcast, not two, for what is one occurrence from an

    operator's perspective. `event_type="Command"` (distinct from

    Telemetry/Battery/Recovery/Warning/Critical) so a command's outcome is

    never confused with a subsystem/alarm-driven event. Intermediate

    stages (SENT, ACKNOWLEDGED) deliberately do NOT get their own

    persisted event — they're already visible via the command's own status

    field and live command_update messages; a mission-timeline row for

    each would flood it with what is, again, one occurrence, not several.

    """

    command.status = new_status

    for field, value in timestamp_fields.items():

        setattr(command, field, value)

    db.commit()

    db.refresh(command)

    command_type = CommandType(command.command_type)

    if new_status == CommandStatus.FAILED:

        message = f"{command.satellite_id}: {command.command_type} failed — {command.failure_reason}"

        severity = "Warning"

    else:

        template = _EXECUTED_EVENT_MESSAGES[command_type]

        detail = template.format(mode=command.parameters["mode"]) if command.parameters else template

        message = f"{command.satellite_id}: {detail}"

        severity = None

    event = Event(

        satellite_id=command.satellite_id,

        timestamp=command.executed_at or datetime.now(UTC),

        event_type="Command",

        severity=severity,

        message=message,

        rule=f"command_{command.command_type.lower()}",

        subsystem="payload" if command_type == CommandType.ENABLE_PAYLOAD else None,

    )

    db.add(event)

    db.commit()

    db.refresh(event)

    await manager.broadcast({

        "type": "command_update",

        **_command_dict(command),

        "event": _event_dict(event),

    })

async def run_command_lifecycle(command_id: int) -> None:

    """

    Advances the command identified by `command_id` through its full

    simulated uplink lifecycle. Scheduled as a FastAPI background task

    from `backend/app/routers/commands.py` — see the module docstring for

    why it opens its own database session rather than reusing the

    request's.

    """

    db = SessionLocal()

    try:

        command = db.query(Command).filter(Command.id == command_id).first()

        if command is None:

            logger.error("run_command_lifecycle called with unknown command_id=%s", command_id)

            return

        await _advance(command, db, CommandStatus.SENT)

        await asyncio.sleep(settings.COMMAND_STAGE_DELAY_SECONDS)

        await _advance(command, db, CommandStatus.ACKNOWLEDGED, acknowledged_at=datetime.now(UTC))

        await asyncio.sleep(settings.COMMAND_STAGE_DELAY_SECONDS)

        command_type = CommandType(command.command_type)

        # --- RESTART_COMPUTER: reject a second concurrent restart -------

        # An atomic UPDATE ... WHERE, not a Python-level read-then-write:

        # `.update()` with a filter is executed as a single SQL statement,

        # so this is safe against a second RESTART_COMPUTER command for

        # the same satellite reaching this exact point at (effectively)

        # the same time — whichever one's UPDATE actually runs first wins

        # (`updated_rows == 1`); the other sees `updated_rows == 0` and

        # fails cleanly. This is enforced by SQLite itself, not by

        # anything in this process, so it holds even across process

        # boundaries — though today, only this backend process ever

        # writes to `satellite_state`; the telemetry-generator process

        # only reads it.

        if command_type == CommandType.RESTART_COMPUTER:

            updated_rows = (

                db.query(SatelliteState)

                .filter(

                    SatelliteState.satellite_id == command.satellite_id,

                    SatelliteState.computer_state != ComputerState.RESTARTING,

                )

                .update({

                    "computer_state": ComputerState.RESTARTING,

                    "updated_at": datetime.now(UTC),

                })

            )

            db.commit()

            if updated_rows == 0:

                command.failure_reason = "Computer is already restarting"

                await _finish(command, db, CommandStatus.FAILED)

                logger.warning(

                    "Command %s FAILED for %s: %s",

                    command.id, command.satellite_id, command.failure_reason

                )

                return

            # Held for its own window before returning to NORMAL — long

            # enough that a telemetry packet generated during this window

            # (see backend/simulator/telemetry_generator.py) genuinely

            # observes computer_state=RESTARTING, not just an instantaneous

            # flicker no one could ever see.

            await asyncio.sleep(settings.COMMAND_STAGE_DELAY_SECONDS)

            (

                db.query(SatelliteState)

                .filter(SatelliteState.satellite_id == command.satellite_id)

                .update({

                    "computer_state": ComputerState.NORMAL,

                    "updated_at": datetime.now(UTC),

                })

            )

            db.commit()

        elif command_type == CommandType.ENABLE_PAYLOAD:

            (

                db.query(SatelliteState)

                .filter(SatelliteState.satellite_id == command.satellite_id)

                .update({"payload_enabled": True, "updated_at": datetime.now(UTC)})

            )

            db.commit()

        elif command_type == CommandType.CHANGE_MODE:

            (

                db.query(SatelliteState)

                .filter(SatelliteState.satellite_id == command.satellite_id)

                .update({

                    "operating_mode": command.parameters["mode"],

                    "updated_at": datetime.now(UTC),

                })

            )

            db.commit()

        elif command_type == CommandType.ENTER_SAFE_MODE:

            (

                db.query(SatelliteState)

                .filter(SatelliteState.satellite_id == command.satellite_id)

                .update({

                    "operating_mode": OperatingMode.SAFE,

                    "updated_at": datetime.now(UTC),

                })

            )

            db.commit()

        await _finish(command, db, CommandStatus.EXECUTED, executed_at=datetime.now(UTC))

        logger.info(

            "Command %s EXECUTED for %s (%s)",

            command.id, command.satellite_id, command.command_type

        )

    finally:

        db.close()