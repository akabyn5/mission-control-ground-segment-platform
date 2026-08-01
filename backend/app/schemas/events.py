"""

Pydantic schema for the persistent mission event log.

`EventResponse` describes a single row from the `events` table (see

backend/app/models/event.py), as returned by `GET /events` and embedded

— as a list, under the `events` key — in the WebSocket telemetry

broadcast whenever `POST /telemetry` generates one or more new events

(see backend/app/core/events.py and backend/app/routers/telemetry.py).

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

            'Kind of event: "Battery", "Recovery", "Warning", or '

            '"Critical" — matches the Mission Timeline event types '

            "already used in the dashboard, so the frontend can render "

            "this value directly."

        ),

        examples=["Critical"],

    )

    severity: HealthStatus | None = Field(

        None,

        description=(

            "Alarm severity for Warning/Critical events, evaluated by "

            "backend/app/core/alarms.py. None for Battery and Recovery "

            "events, which are not alarm-classified."

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

        json_schema_extra={"examples": [_EXAMPLE_EVENT]}

    )