"""

Simulated command uplink API.

`POST /commands` queues a command and returns immediately (`202

Accepted`) with its initial `QUEUED` state; the actual simulated uplink

lifecycle (SENT -> ACKNOWLEDGED -> EXECUTED/FAILED) runs afterward, in the

background — see backend/app/core/commands.py — broadcasting each stage

transition over the existing WebSocket connection as a `"command_update"`

message. `GET /commands`/`GET /commands/{command_id}` retrieve command

history. `GET /satellite-state/{satellite_id}` returns a satellite's

current simulated state — the same endpoint

backend/simulator/telemetry_generator.py polls, over HTTP, before

building each telemetry packet, since the backend and the telemetry

generator run as separate processes with no shared Python memory (see

backend/app/models/satellite_state.py's docstring).

"""

from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status

from sqlalchemy.exc import SQLAlchemyError

from sqlalchemy.orm import Session

from backend.app.core.commands import run_command_lifecycle

from backend.app.core.logging_config import get_logger

from backend.app.database.dependencies import get_db

from backend.app.models.command import Command, CommandStatus, CommandType

from backend.app.models.satellite_state import SatelliteState

from backend.app.schemas.commands import CommandCreate, CommandResponse, SatelliteStateResponse

from backend.simulator.fleet import SATELLITE_IDS

router = APIRouter(tags=["Commands"])

logger = get_logger(__name__)

def _require_known_satellite(satellite_id: str) -> None:

    """Raises 404 for a satellite_id outside the configured fleet (backend/simulator/fleet.py) — a well-formed string that just doesn't refer to anything, unlike a validation error."""

    if satellite_id not in SATELLITE_IDS:

        raise HTTPException(

            status_code=status.HTTP_404_NOT_FOUND,

            detail=f"Unknown satellite_id {satellite_id!r}. Configured fleet: {list(SATELLITE_IDS)}",

        )

@router.post(

    "/commands",

    response_model=CommandResponse,

    status_code=status.HTTP_202_ACCEPTED,

    summary="Send a command to a satellite",

    description=(

        "Queues a command for simulated uplink to a satellite and returns "

        "immediately with its initial `QUEUED` state — this endpoint does "

        "NOT wait for the command to finish executing. The full simulated "

        "lifecycle (`SENT` -> `ACKNOWLEDGED` -> `EXECUTED`/`FAILED`) runs "

        "afterward in the background (see backend/app/core/commands.py), "

        "broadcasting a `\"command_update\"` WebSocket message after each "

        "stage transition. Poll `GET /commands/{command_id}` or listen for "

        "those WebSocket messages to observe progress.\n\n"

        "`CHANGE_MODE` requires `parameters` to be exactly "

        '`{"mode": "NOMINAL" | "SAFE"}`; every other command type must '

        "omit `parameters` entirely."

    ),

    operation_id="create_command",

    responses={

        202: {

            "description": "Command accepted and queued for simulated uplink.",

            "content": {

                "application/json": {

                    "example": {

                        "id": 5,

                        "satellite_id": "SD-CUBESAT-001",

                        "command_type": "CHANGE_MODE",

                        "parameters": {"mode": "SAFE"},

                        "status": "QUEUED",

                        "failure_reason": None,

                        "created_at": "2026-07-27T18:35:12Z",

                        "acknowledged_at": None,

                        "executed_at": None,

                    }

                }

            },

        },

        404: {

            "description": "satellite_id is not part of the configured fleet.",

        },

        422: {

            "description": (

                "The command failed validation — an unsupported command "

                "type, a missing/invalid `mode` for CHANGE_MODE, or "

                "unexpected parameters for a command that takes none."

            ),

        },

        500: {

            "description": "A database error occurred while storing the command.",

        },

    },

)

async def create_command(

    command: CommandCreate,

    background_tasks: BackgroundTasks,

    db: Session = Depends(get_db),

) -> CommandResponse:

    _require_known_satellite(command.satellite_id)

    db_command = Command(

        satellite_id=command.satellite_id,

        command_type=command.command,

        parameters=command.parameters,

        status=CommandStatus.QUEUED,

        created_at=datetime.utcnow(),

    )

    try:

        db.add(db_command)

        db.commit()

        db.refresh(db_command)

    except SQLAlchemyError:

        db.rollback()

        logger.exception(

            "Database commit failed while storing command for %s",

            command.satellite_id

        )

        raise HTTPException(

            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,

            detail="A database error occurred while storing the command.",

        )

    logger.info(

        "Command %s queued for %s (%s)",

        db_command.id, db_command.satellite_id, db_command.command_type

    )

    background_tasks.add_task(run_command_lifecycle, db_command.id)

    return db_command

@router.get(

    "/commands",

    response_model=list[CommandResponse],

    status_code=status.HTTP_200_OK,

    summary="List command history",

    description=(

        "Returns persisted commands ordered by creation time, newest "

        "first, with `limit`/`offset` pagination and optional "

        "`satellite_id`/`command_type`/`status`/`from`/`to` filtering. "

        "Survives backend restarts — this is the durable command history, "

        "independent of each satellite's current state (see "

        "`GET /satellite-state/{satellite_id}`)."

    ),

    operation_id="list_commands",

)

def get_commands(

    limit: int = Query(100, ge=1, le=1000, description="Maximum number of commands to return.", examples=[100]),

    offset: int = Query(0, ge=0, description="Number of matching commands to skip, for pagination.", examples=[0]),

    satellite_id: str | None = Query(None, min_length=1, description="Return only commands sent to this satellite.", examples=["SD-CUBESAT-001"]),

    command_type: str | None = Query(None, min_length=1, description="Return only commands of this exact type.", examples=["CHANGE_MODE"]),

    status_filter: str | None = Query(None, alias="status", min_length=1, description="Return only commands currently in this exact lifecycle status.", examples=["EXECUTED"]),

    from_: datetime | None = Query(None, alias="from", description="Return only commands created at or after this timestamp (ISO 8601).", examples=["2026-07-20T00:00:00Z"]),

    to: datetime | None = Query(None, description="Return only commands created at or before this timestamp (ISO 8601).", examples=["2026-07-27T00:00:00Z"]),

    db: Session = Depends(get_db),

) -> list[CommandResponse]:

    try:

        query = db.query(Command)

        if satellite_id is not None:

            query = query.filter(Command.satellite_id == satellite_id)

        if command_type is not None:

            query = query.filter(Command.command_type == command_type)

        if status_filter is not None:

            query = query.filter(Command.status == status_filter)

        if from_ is not None:

            query = query.filter(Command.created_at >= from_)

        if to is not None:

            query = query.filter(Command.created_at <= to)

        return (

            query

            .order_by(Command.created_at.desc())

            .offset(offset)

            .limit(limit)

            .all()

        )

    except SQLAlchemyError:

        logger.exception("Database query failed while listing commands")

        raise HTTPException(

            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,

            detail="A database error occurred while retrieving command history.",

        )

@router.get(

    "/commands/{command_id}",

    response_model=CommandResponse,

    status_code=status.HTTP_200_OK,

    summary="Get a single command",

    description="Returns one command's current lifecycle state by its database ID.",

    operation_id="get_command",

    responses={

        404: {"description": "No command with this ID exists."},

    },

)

def get_command(command_id: int, db: Session = Depends(get_db)) -> CommandResponse:

    command = db.query(Command).filter(Command.id == command_id).first()

    if command is None:

        raise HTTPException(

            status_code=status.HTTP_404_NOT_FOUND,

            detail=f"No command with id {command_id}.",

        )

    return command

@router.get(

    "/satellite-state/{satellite_id}",

    response_model=SatelliteStateResponse,

    status_code=status.HTTP_200_OK,

    summary="Get a satellite's current simulated state",

    description=(

        "Returns a satellite's current simulated state — operating mode, "

        "payload enabled/disabled, and flight-computer state — reflecting "

        "every EXECUTED command sent to it so far. This is the same "

        "endpoint the telemetry simulator itself polls, over HTTP, before "

        "building each telemetry packet (see "

        "backend/simulator/telemetry_generator.py), since the backend and "

        "the simulator run as separate processes with no shared memory."

    ),

    operation_id="get_satellite_state",

    responses={

        404: {"description": "satellite_id is not part of the configured fleet, or its state row has not been initialized yet."},

    },

)

def get_satellite_state(satellite_id: str, db: Session = Depends(get_db)) -> SatelliteStateResponse:

    _require_known_satellite(satellite_id)

    state = db.query(SatelliteState).filter(SatelliteState.satellite_id == satellite_id).first()

    if state is None:

        # Should not normally happen — ensure_satellite_states() (see

        # backend/app/models/satellite_state.py) runs at backend startup

        # and creates a row for every satellite in the fleet — but this is

        # a well-defined, honest 404 rather than a 500 if it's ever hit

        # (e.g. a request arriving before startup finished).

        raise HTTPException(

            status_code=status.HTTP_404_NOT_FOUND,

            detail=f"No state recorded yet for satellite_id {satellite_id!r}.",

        )

    return state