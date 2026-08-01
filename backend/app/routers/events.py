"""

Persistent mission event log endpoint.

"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status

from sqlalchemy.exc import SQLAlchemyError

from sqlalchemy.orm import Session

from backend.app.core.logging_config import get_logger

from backend.app.database.dependencies import get_db

from backend.app.models.event import Event

from backend.app.schemas.events import EventResponse

router = APIRouter(tags=["Events"])

logger = get_logger(__name__)

@router.get(

    "/events",

    response_model=list[EventResponse],

    status_code=status.HTTP_200_OK,

    summary="List persisted mission events",

    description=(

        "Returns persisted mission events — Battery drops, subsystem "

        "Recoveries, and newly-triggered Warning/Critical alarms (see "

        "backend/app/core/events.py) — ordered by timestamp, newest "

        "first, with `limit`/`offset` pagination and optional "

        "`satellite_id`/`event_type`/`severity`/`subsystem`/`from`/`to` "

        "filtering.\n\n"

        "Unlike `GET /telemetry/history`, this does NOT include a row "

        'for every telemetry packet — only anomalies ("Telemetry '

        'received" is not persisted; see the module docstring in '

        "backend/app/models/event.py for why). The dashboard's Mission "

        "Timeline uses this endpoint to bootstrap its historical view on "

        "page load, then receives newly-created events live over the "

        "WebSocket telemetry broadcast (embedded under an `events` key) "

        "as they occur.\n\n"

        "**All supplied filters are combined with AND.** An empty result "

        "— no events yet, or none match the given filters — is a normal "

        "outcome for a collection endpoint and returns **HTTP 200** with "

        "an empty array."

    ),

    operation_id="list_events",

    responses={

        200: {

            "description": "Zero or more mission events matching the given filters, newest first.",

            "content": {

                "application/json": {

                    "example": [

                        {

                            "id": 17,

                            "satellite_id": "SD-CUBESAT-001",

                            "timestamp": "2026-07-27T18:35:12Z",

                            "event_type": "Critical",

                            "severity": "Critical",

                            "message": "SD-CUBESAT-001: Battery failure (battery at 17.0%)",

                            "rule": "power_critical",

                            "subsystem": "power",

                        }

                    ]

                }

            },

        },

        400: {

            "description": "'from' is after 'to', or the two cannot be compared (mismatched timezone awareness).",

            "content": {

                "application/json": {

                    "example": {

                        "detail": "The 'from' timestamp must not be after the 'to' timestamp."

                    }

                }

            },

        },

        422: {

            "description": (

                "A query parameter failed validation — for example, `limit` "

                "outside its allowed range, or an unparsable `from`/`to` date."

            ),

        },

        500: {

            "description": "A database error occurred while querying mission events.",

            "content": {

                "application/json": {

                    "example": {

                        "detail": "A database error occurred while retrieving mission events."

                    }

                }

            },

        },

    },

)

def get_events(

    limit: int = Query(

        100,

        ge=1,

        le=1000,

        description="Maximum number of events to return.",

        examples=[100],

    ),

    offset: int = Query(

        0,

        ge=0,

        description="Number of matching events to skip, for pagination.",

        examples=[0],

    ),

    satellite_id: str | None = Query(

        None,

        min_length=1,

        description="Return only events from this satellite.",

        examples=["SD-CUBESAT-001"],

    ),

    event_type: str | None = Query(

        None,

        min_length=1,

        description='Return only events of this exact type (e.g. "Battery", "Recovery", "Warning", "Critical").',

        examples=["Critical"],

    ),

    severity: str | None = Query(

        None,

        min_length=1,

        description='Return only events with this exact severity ("Warning" or "Critical"). Battery and Recovery events have no severity and are excluded by this filter.',

        examples=["Critical"],

    ),

    subsystem: str | None = Query(

        None,

        min_length=1,

        description="Return only events related to this subsystem.",

        examples=["power"],

    ),

    from_: datetime | None = Query(

        None,

        alias="from",

        description="Return only events with a timestamp greater than or equal to this value (ISO 8601).",

        examples=["2026-07-20T00:00:00Z"],

    ),

    to: datetime | None = Query(

        None,

        description="Return only events with a timestamp less than or equal to this value (ISO 8601).",

        examples=["2026-07-27T00:00:00Z"],

    ),

    db: Session = Depends(get_db),

) -> list[EventResponse]:

    if from_ is not None and to is not None:

        try:

            invalid_range = from_ > to

        except TypeError:

            raise HTTPException(

                status_code=status.HTTP_400_BAD_REQUEST,

                detail=(

                    "'from' and 'to' must both be timezone-aware or both "

                    "be naive — a value with a UTC offset (e.g. a "

                    "trailing 'Z') cannot be compared with one that has "

                    "none."

                ),

            )

        if invalid_range:

            raise HTTPException(

                status_code=status.HTTP_400_BAD_REQUEST,

                detail="The 'from' timestamp must not be after the 'to' timestamp.",

            )

    try:

        query = db.query(Event)

        if satellite_id is not None:

            query = query.filter(Event.satellite_id == satellite_id)

        if event_type is not None:

            query = query.filter(Event.event_type == event_type)

        if severity is not None:

            query = query.filter(Event.severity == severity)

        if subsystem is not None:

            query = query.filter(Event.subsystem == subsystem)

        if from_ is not None:

            query = query.filter(Event.timestamp >= from_)

        if to is not None:

            query = query.filter(Event.timestamp <= to)

        return (

            query

            .order_by(Event.timestamp.desc())

            .offset(offset)

            .limit(limit)

            .all()

        )

    except SQLAlchemyError:

        logger.exception("Database query failed while listing events")

        raise HTTPException(

            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,

            detail="A database error occurred while retrieving mission events.",

        )