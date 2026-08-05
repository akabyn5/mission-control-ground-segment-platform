"""

Simulated command uplink execution.

This module is the single source of truth for "what happens when this

command executes." `backend/app/routers/commands.py` schedules

`run_command_lifecycle()` as a FastAPI background task immediately after

persisting a command's initial QUEUED row and returning `202 Accepted` —

it does not run inline within the request/response cycle. FastAPI's

`BackgroundTasks` (standard library — no Celery/Redis/Kafka needed) let

`POST /commands` respond immediately and let this function keep running

afterward, on the same asyncio event loop.

`run_command_lifecycle()` advances a command through SENT ->

ACKNOWLEDGED -> EXECUTED/FAILED, committing the `commands` row's status

after each stage and broadcasting a `"command_update"` WebSocket message

after each one. The FINAL stage — applying the command's effect to

`satellite_state`, marking the command EXECUTED/FAILED, and recording its

one terminal mission Event — happens as a SINGLE database transaction

(see `_finish()`), so a partial failure there can never leave the

satellite_state, the command's own status, and the event log

disagreeing with each other; and the WebSocket broadcast for that terminal

state only happens once that transaction has actually committed, so the

dashboard is never told about a state that wasn't durably saved.

Since the backend and the telemetry-generator process run as separate OS

processes with no shared Python memory, `satellite_state` is a database

table (backend/app/models/satellite_state.py), not an in-process object —

see that module's docstring for the full reasoning.

Restart recovery:

FastAPI `BackgroundTasks` are process-local, not a durable queue — if the

backend restarts while a command's lifecycle coroutine is mid-flight

(status QUEUED/SENT/ACKNOWLEDGED), that coroutine is simply gone; nothing

will ever advance that command again. `reconcile_after_restart()` below

is called once at startup (see backend/app/main.py) to resolve exactly

that: any command left in a non-terminal status is marked FAILED with a

clear reason, and any satellite left with computer_state=RESTARTING (which

can only happen mid-way through an ACKNOWLEDGED-or-later RESTART_COMPUTER

command) is reset to NORMAL, since the process that was going to do that

itself no longer exists.

"""

import asyncio

from datetime import datetime, UTC

from sqlalchemy.exc import SQLAlchemyError

from sqlalchemy.orm import Session

from backend.app.core.config import settings

from backend.app.core.logging_config import get_logger

from backend.app.database.database import SessionLocal

from backend.app.models.command import Command, CommandStatus, CommandType

from backend.app.models.event import Event

from backend.app.models.satellite_state import ComputerState, OperatingMode, SatelliteState

from backend.app.websocket.connection_manager import manager

logger = get_logger(__name__)

# Human-readable event message per command type, used only for the

# terminal "Command" mission event (EXECUTED) — see _finish()'s docstring

# for why intermediate stages don't get their own persisted event. FAILED

# events build their message from `command.failure_reason` instead (see

# _build_event below).

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

def _build_event(command: Command) -> Event:

    """

    Builds (but does not add/commit) the one terminal mission Event for

    `command`, based on its CURRENT `status`/`failure_reason` — the caller

    is expected to have already set those. Shared by both the normal

    lifecycle path (_finish, below) and the startup restart-recovery path

    (reconcile_after_restart, below), so a command's terminal event is

    worded identically regardless of which of those two paths produced it.

    """

    command_type = CommandType(command.command_type)

    if command.status == CommandStatus.FAILED:

        message = f"{command.satellite_id}: {command.command_type} failed — {command.failure_reason}"

        severity = "Warning"

    else:

        template = _EXECUTED_EVENT_MESSAGES[command_type]

        detail = template.format(mode=command.parameters["mode"]) if command.parameters else template

        message = f"{command.satellite_id}: {detail}"

        severity = None

    return Event(

        satellite_id=command.satellite_id,

        timestamp=command.executed_at or datetime.now(UTC),

        event_type="Command",

        severity=severity,

        message=message,

        rule=f"command_{command.command_type.lower()}",

        subsystem="payload" if command_type == CommandType.ENABLE_PAYLOAD else None,

    )

async def _advance(command: Command, db: Session, new_status: CommandStatus, **timestamp_fields) -> None:

    """

    Non-terminal stage transition (SENT, ACKNOWLEDGED): sets

    `command.status` and any given timestamp columns, commits, refreshes,

    and broadcasts the resulting state. See _finish() below for the

    terminal (EXECUTED/FAILED) case, which commits the satellite_state

    change, the command's final status, and its mission Event together, as

    one transaction, instead of using this function.

    """

    command.status = new_status

    for field, value in timestamp_fields.items():

        setattr(command, field, value)

    db.commit()

    db.refresh(command)

    await manager.broadcast({"type": "command_update", **_command_dict(command)})

async def _finish(

    command: Command,

    db: Session,

    new_status: CommandStatus,

    *,

    satellite_state_update: dict | None = None,

    **timestamp_fields,

) -> None:

    """

    Terminal stage transition (EXECUTED or FAILED) — the one place a

    command's satellite_state effect (if any), its final status, and its

    mission Event are all applied. All three are added to the session and

    committed together, in a SINGLE transaction: if the commit fails, none

    of the three take effect (SQLAlchemy rolls the whole session back), so

    satellite_state, the command's own status, and the event log can never

    end up disagreeing about whether this command actually happened. The

    WebSocket broadcast — carrying both the final command state and the

    new event together, one broadcast, not two — only happens AFTER that

    commit has actually succeeded; a state that failed to persist is never

    announced as if it had.

    `satellite_state_update`, if given, is applied via a single

    `UPDATE ... WHERE satellite_id = ...` against `satellite_state`, in the

    same transaction as everything else here — not via a separate,

    already-committed change earlier in the lifecycle (RESTART_COMPUTER's

    initial "claim the restart" compare-and-set in run_command_lifecycle()

    is the one deliberate exception: that one has to happen earlier and

    separately, since it's a concurrency guard other commands need to see

    immediately, not something to hold open across the remaining simulated

    uplink delay).

    """

    if satellite_state_update is not None:

        (

            db.query(SatelliteState)

            .filter(SatelliteState.satellite_id == command.satellite_id)

            .update(satellite_state_update)

        )

    command.status = new_status

    for field, value in timestamp_fields.items():

        setattr(command, field, value)

    event = _build_event(command)

    db.add(event)

    try:

        db.commit()

    except SQLAlchemyError:

        db.rollback()

        logger.exception(

            "Failed to commit terminal state for command %s (%s, %s) — "

            "satellite_state, command status, and the mission event were "

            "all rolled back together; nothing was partially applied.",

            command.id, command.satellite_id, command.command_type

        )

        raise

    db.refresh(command)

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

    from `backend/app/routers/commands.py`. Opens its own database session

    — background tasks can outlive the request that scheduled them, so

    reusing that request's `Depends(get_db)` session would be relying on

    FastAPI's dependency-cleanup timing relative to background-task

    completion, which this avoids entirely by not sharing a session at all.

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

        if command_type == CommandType.RESTART_COMPUTER:

            # Claim the restart with an atomic UPDATE ... WHERE, not a

            # Python-level read-then-write: `.update()` with a filter is

            # executed as a single SQL statement, so this is safe against

            # a second RESTART_COMPUTER command for the same satellite

            # reaching this exact point at (effectively) the same time —

            # whichever one's UPDATE actually runs first wins

            # (`claimed_rows == 1`); the other sees `claimed_rows == 0` and

            # fails cleanly. Deliberately a separate, immediately-committed

            # step (unlike the satellite_state changes for every other

            # command type below, which go through _finish() as part of

            # the single terminal transaction) — other commands need to be

            # able to see "this satellite is already restarting" right

            # away, not only after this command's own multi-second

            # simulated uplink delay finishes.

            claimed_rows = (

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

            if claimed_rows == 0:

                command.failure_reason = "Computer is already restarting"

                await _finish(command, db, CommandStatus.FAILED)

                logger.warning(

                    "Command %s FAILED for %s: %s",

                    command.id, command.satellite_id, command.failure_reason

                )

                return

            # Held for its own window — long enough that a telemetry packet

            # generated during it (see

            # backend/simulator/telemetry_generator.py) genuinely observes

            # computer_state=RESTARTING, not just an instantaneous flicker

            # no one could ever see.

            await asyncio.sleep(settings.COMMAND_STAGE_DELAY_SECONDS)

            state_update = {"computer_state": ComputerState.NORMAL, "updated_at": datetime.now(UTC)}

        elif command_type == CommandType.ENABLE_PAYLOAD:

            state_update = {"payload_enabled": True, "updated_at": datetime.now(UTC)}

        elif command_type == CommandType.CHANGE_MODE:

            state_update = {"operating_mode": command.parameters["mode"], "updated_at": datetime.now(UTC)}

        elif command_type == CommandType.ENTER_SAFE_MODE:

            state_update = {"operating_mode": OperatingMode.SAFE, "updated_at": datetime.now(UTC)}

        else:

            state_update = None

        await _finish(

            command, db, CommandStatus.EXECUTED,

            satellite_state_update=state_update,

            executed_at=datetime.now(UTC),

        )

        logger.info(

            "Command %s EXECUTED for %s (%s)",

            command.id, command.satellite_id, command.command_type

        )

    finally:

        db.close()

def reconcile_after_restart(db: Session) -> None:

    """

    Startup reconciliation for state a backend restart can leave

    inconsistent — see the module docstring's "Restart recovery" section

    for why this is necessary at all. Called once from

    backend/app/main.py, after ensure_satellite_states(). Synchronous

    (not async): runs during application startup, before the event loop is

    serving requests, so there's no WebSocket client connected yet to

    broadcast to — commands resolved here simply show their FAILED status

    the next time anything queries GET /commands or GET /commands/{id}.

    """

    interrupted_commands = (

        db.query(Command)

        .filter(Command.status.in_([

            CommandStatus.QUEUED,

            CommandStatus.SENT,

            CommandStatus.ACKNOWLEDGED,

        ]))

        .all()

    )

    for command in interrupted_commands:

        command.status = CommandStatus.FAILED

        command.failure_reason = "Command lifecycle interrupted by backend restart"

        command.executed_at = datetime.now(UTC)

        db.add(_build_event(command))

        logger.warning(

            "Command %s for %s marked FAILED at startup (interrupted by restart)",

            command.id, command.satellite_id

        )

    stuck_states = (

        db.query(SatelliteState)

        .filter(SatelliteState.computer_state == ComputerState.RESTARTING)

        .all()

    )

    for state in stuck_states:

        state.computer_state = ComputerState.NORMAL

        state.updated_at = datetime.now(UTC)

        logger.warning(

            "Reset stuck computer_state=RESTARTING for %s at startup",

            state.satellite_id

        )

    if interrupted_commands or stuck_states:

        db.commit()