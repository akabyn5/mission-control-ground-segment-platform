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

after each one. The terminal stage — applying the command's effect to

`satellite_state`, marking the command EXECUTED/FAILED, and recording its

one terminal mission Event — happens as a SINGLE database transaction

(see `_finish()`), so a partial failure there can never leave

satellite_state, the command's own status, and the event log disagreeing

with each other; the WebSocket broadcast for that terminal state only

happens once that transaction has actually committed.

Since the backend and the telemetry-generator process run as separate OS

processes with no shared Python memory, `satellite_state` is a database

table (backend/app/models/satellite_state.py), not an in-process object —

see that module's docstring for the full reasoning. The OLD in-process

module `backend/simulator/satellite_state.py` is retired; this module and

backend/app/models/satellite_state.py are the only satellite-state

implementation now.

Per-satellite command ordering:

`_SATELLITE_LOCKS` below gives each satellite its own `asyncio.Lock`, held

for a command's ENTIRE lifecycle (from SENT through EXECUTED/FAILED) —

not just around the moment of a `satellite_state` mutation. A second

command submitted for a satellite that already has one in flight simply

waits for the first to fully finish before its own SENT stage even

starts. This is what makes "CHANGE_MODE SAFE" immediately followed by

"CHANGE_MODE NOMINAL" always execute in that submission order, rather

than leaving the final state to whichever one's `asyncio.sleep()`

happened to resolve first. Commands for DIFFERENT satellites are

unaffected by each other's locks and run fully concurrently.

Failure recovery — two layers:

1. Mid-lifecycle failures (e.g. a transient database error between

   stages) are caught by `run_command_lifecycle()`'s own try/except and

   handled by `_compensate_and_fail()`: any `satellite_state` change

   already made (specifically, a RESTART_COMPUTER that had already set

   `computer_state = RESTARTING`) is reset, the command is marked FAILED

   with a clear reason, and its terminal Event is recorded — all in one

   transaction, broadcast only after it commits.

2. Whole-PROCESS failures (the backend itself restarts mid-lifecycle) are

   handled separately, at startup, by `reconcile_after_restart()` below —

   see its own docstring.

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

# One asyncio.Lock per satellite — see "Per-satellite command ordering" in

# the module docstring. A plain dict + a small accessor (rather than

# collections.defaultdict directly) so the "create a Lock for a

# never-before-seen satellite_id" step is explicit and easy to find.

_SATELLITE_LOCKS: dict[str, asyncio.Lock] = {}

def _lock_for(satellite_id: str) -> asyncio.Lock:

    """

    Returns the asyncio.Lock for `satellite_id`, creating one on first use.

    Safe under asyncio's single-threaded concurrency model: this function

    contains no `await`, so it always runs to completion without another

    coroutine interleaving partway through it — two commands for a

    brand-new satellite_id arriving "at the same time" can't each create

    and use a different Lock object, the way they could under true

    multi-threading.

    """

    lock = _SATELLITE_LOCKS.get(satellite_id)

    if lock is None:

        lock = asyncio.Lock()

        _SATELLITE_LOCKS[satellite_id] = lock

    return lock

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

    is expected to have already set those. Shared by every path that can

    produce a command's terminal state: the normal lifecycle (`_finish`),

    mid-lifecycle compensating failure (`_compensate_and_fail`), and

    startup restart recovery (`reconcile_after_restart`) — so a command's

    terminal event is worded identically no matter which of those produced

    it.

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

    and broadcasts the resulting state. A `SQLAlchemyError` here propagates

    to the caller (run_command_lifecycle's try/except), which routes it to

    `_compensate_and_fail()` — this function does not attempt its own

    recovery, since at this stage there is no satellite_state effect yet

    to compensate for.

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

    mission Event are all applied, in a SINGLE transaction: if the commit

    fails, none of the three take effect. The WebSocket broadcast — final

    command state and the new event together, one broadcast, not two —

    only happens after that commit has actually succeeded.

    If `satellite_state_update` is given but does not update EXACTLY one

    `satellite_state` row (0, because the row doesn't exist; or more than

    1, which should be structurally impossible given `satellite_id` is

    unique — checked anyway rather than assumed), `new_status` is

    overridden to FAILED: a command is never reported EXECUTED when its

    actual effect could not be verified as applied.

    """

    if satellite_state_update is not None:

        updated_rows = (

            db.query(SatelliteState)

            .filter(SatelliteState.satellite_id == command.satellite_id)

            .update(satellite_state_update)

        )

        if updated_rows != 1:

            new_status = CommandStatus.FAILED

            command.failure_reason = (

                f"Expected exactly 1 satellite_state row for "

                f"{command.satellite_id!r}, updated {updated_rows}"

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

async def _compensate_and_fail(command_id: int, db: Session, satellite_id: str, reason: str) -> None:

    """

    Last-resort recovery when something inside the `try` block of

    `run_command_lifecycle()` raises partway through — e.g. a transient

    database error between stages, or after a RESTART_COMPUTER has already

    claimed `computer_state = RESTARTING`. The session may be in a

    dirty/half-applied state at this point, so this starts from a clean

    `rollback()` and re-fetches the command fresh, then performs its own

    small, self-contained compensating transaction: if `satellite_id`'s

    `computer_state` is currently RESTARTING, it's reset to NORMAL (the

    only command that could ever set it back is the one that just failed);

    the command is marked FAILED with `reason`; and its one terminal Event

    is recorded — the same one-transaction, broadcast-only-after-commit

    guarantee `_finish()` gives the normal path.

    """

    db.rollback()

    command = db.query(Command).filter(Command.id == command_id).first()

    if command is None:

        logger.error(

            "Command %s disappeared during compensating rollback — nothing to recover.",

            command_id

        )

        return

    (

        db.query(SatelliteState)

        .filter(

            SatelliteState.satellite_id == satellite_id,

            SatelliteState.computer_state == ComputerState.RESTARTING,

        )

        .update({"computer_state": ComputerState.NORMAL, "updated_at": datetime.now(UTC)})

    )

    command.status = CommandStatus.FAILED

    command.failure_reason = reason

    command.executed_at = datetime.now(UTC)

    event = _build_event(command)

    db.add(event)

    try:

        db.commit()

    except SQLAlchemyError:

        db.rollback()

        logger.exception(

            "Compensating rollback itself failed for command %s — left in "

            "its last known status; will be caught by "

            "reconcile_after_restart() on the next backend startup.",

            command.id

        )

        return

    db.refresh(command)

    db.refresh(event)

    logger.warning("Command %s FAILED for %s: %s", command.id, command.satellite_id, reason)

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

    reusing that request's `Depends(get_db)` session here would be relying

    on FastAPI's dependency-cleanup timing relative to background-task

    completion, which this avoids entirely by not sharing a session at all.

    """

    db = SessionLocal()

    try:

        command = db.query(Command).filter(Command.id == command_id).first()

        if command is None:

            logger.error("run_command_lifecycle called with unknown command_id=%s", command_id)

            return

        satellite_id = command.satellite_id

        lock = _lock_for(satellite_id)

        async with lock:

            try:

                await _advance(command, db, CommandStatus.SENT)

                await asyncio.sleep(settings.COMMAND_STAGE_DELAY_SECONDS)

                await _advance(command, db, CommandStatus.ACKNOWLEDGED, acknowledged_at=datetime.now(UTC))

                await asyncio.sleep(settings.COMMAND_STAGE_DELAY_SECONDS)

                command_type = CommandType(command.command_type)

                if command_type == CommandType.RESTART_COMPUTER:

                    # Claim the restart with an atomic UPDATE ... WHERE.

                    # Under normal operation the per-satellite lock above

                    # already guarantees no other command for this

                    # satellite can be running concurrently, so this

                    # should never actually see `claimed_rows == 0` in

                    # practice — kept anyway as a correctness check that

                    # doesn't depend on that invariant holding (e.g. it

                    # remains correct even if this project were ever

                    # deployed with more than one backend worker process,

                    # where this in-process lock alone would not be

                    # enough, but this atomic UPDATE still would be).

                    claimed_rows = (

                        db.query(SatelliteState)

                        .filter(

                            SatelliteState.satellite_id == satellite_id,

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

                            command.id, satellite_id, command.failure_reason

                        )

                        return

                    # Held for its own window — long enough that a

                    # telemetry packet generated during it (see

                    # backend/simulator/telemetry_generator.py) genuinely

                    # observes computer_state=RESTARTING, not just an

                    # instantaneous flicker no one could ever see.

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

                    command.id, satellite_id, command.command_type

                )

            except Exception:

                logger.exception(

                    "Command %s lifecycle failed unexpectedly for %s (%s) — "

                    "performing compensating rollback",

                    command.id, satellite_id, command.command_type

                )

                await _compensate_and_fail(

                    command.id, db, satellite_id,

                    reason="Command execution failed unexpectedly",

                )

    finally:

        db.close()

def reconcile_after_restart(db: Session) -> None:

    """

    Startup reconciliation for state a BACKEND-PROCESS restart can leave

    inconsistent — distinct from `_compensate_and_fail()` above, which

    handles a single command failing while the backend process keeps

    running. FastAPI `BackgroundTasks` are process-local, not a durable

    queue: if the whole backend restarts while a command's lifecycle

    coroutine is mid-flight (status QUEUED/SENT/ACKNOWLEDGED), that

    coroutine — and every in-process `asyncio.Lock` in `_SATELLITE_LOCKS`

    above — is simply gone; nothing will ever advance that command again.

    Called once at startup (see backend/app/main.py), after

    ensure_satellite_states(). Synchronous (not async): runs before the

    event loop is serving requests, so there is no WebSocket client

    connected yet to broadcast to — commands resolved here simply show

    their FAILED status the next time anything queries `GET /commands` or

    `GET /commands/{id}`.

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