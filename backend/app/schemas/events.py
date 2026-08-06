"""

Pydantic schema for the persistent mission event log.

`EventResponse` describes a single row from the `events` table (see

backend/app/models/event.py), as returned by `GET /events` and embedded

in two different WebSocket message shapes: under the `events` key in a

`"type": "telemetry"` broadcast whenever `POST /telemetry` generates one

or more new events (see backend/app/core/events.py and

backend/app/routers/telemetry.py), and under the `event` key in a

terminal `"type": "command_update"` message whenever a command reaches

EXECUTED or FAILED (see backend/app/core/commands.py).

Supported `event_type` values: "Telemetry" (frontend-only — see

frontend/js/dashboard.js; never actually persisted, so it never appears

in a response from this schema), "Battery", "Recovery", "Warning",

"Critical", and "Command" — the last one distinguishing a command's

outcome from every subsystem/alarm-driven event above it.

"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from backend.app.core.health_status import HealthStatus

_EXAMPLE_EVENT = {

    "id": 17,

    "satellite_id": "SD-CUBESAT-001",

    "timestamp": "2026-07-27T18:35:12Z",

    "event_type": "Critical",

    "severity": "Critical",

    "message": "SD-CUBESAT-001: Battery failure (battery at 17.0%)",

    "rule": "power_critical",

    "subsystem": "power",

}

_EXAMPLE_COMMAND_EVENT = {

    "id": 18,

    "satellite_id": "SD-CUBESAT-001",

    "timestamp": "2026-07-27T18:36:40Z",

    "event_type": "Command",

    "severity": None,

    "message": "SD-CUBESAT-001: Payload enabled",

    "rule": "command_enable_payload",

    "subsystem": "payload",

}

class EventResponse(BaseModel):

    """A single persisted mission event."""

    id: int = Field(

        ...,

        description="Database identifier of the event.",

        examples=[17],

    )

    satellite_id: str = Field(

        ...,

        description="Satellite this event was recorded for.",

        examples=["SD-CUBESAT-001"],

    )

    timestamp: datetime = Field(

        ...,

        description="UTC timestamp when the event occurred — the triggering telemetry sample's own timestamp, not when it was written to the database.",

        examples=["2026-07-27T18:35:12Z"],

    )

    event_type: str = Field(

        ...,

        description=(

            'Kind of event: "Battery", "Recovery", "Warning", "Critical", '

            'or "Command" — matches the Mission Timeline event types '

            "already used in the dashboard, so the frontend can render "

            'this value directly. "Command" (see '

            "backend/app/core/commands.py) marks a command's terminal "

            "outcome — EXECUTED or FAILED — distinctly from every "

            "subsystem/alarm-driven event above it; check `severity` to "

            "tell the two apart (None for a successful command, "

            '"Warning" for a failed one).'

        ),

        examples=["Critical"],

    )

    severity: HealthStatus | None = Field(

        None,

        description=(

            "Alarm severity for Warning/Critical events, evaluated by "

            "backend/app/core/alarms.py. None for Battery and Recovery "

            "events (not alarm-classified) and for a successfully "

            'EXECUTED Command event; "Warning" for a FAILED Command event.'

        ),

        examples=["Critical"],

    )

    message: str = Field(

        ...,

        description="Short, human-readable description of the event.",

        examples=["SD-CUBESAT-001: Battery failure (battery at 17.0%)"],

    )

    rule: str = Field(

        ...,

        description="Stable, machine-readable identifier for what triggered this event.",

        examples=["power_critical"],

    )

    subsystem: str | None = Field(

        None,

        description="Which subsystem this event relates to, if any. None for events with no specific subsystem (e.g. a CPU load alarm).",

        examples=["power"],

    )

    model_config = ConfigDict(

        from_attributes=True,

        json_schema_extra={"examples": [_EXAMPLE_EVENT, _EXAMPLE_COMMAND_EVENT]}

    )