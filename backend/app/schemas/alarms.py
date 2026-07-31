"""

Pydantic schema for a single triggered alarm.

Alarm objects are produced by `evaluate_alarms()` in

`backend/app/core/alarms.py` and attached to telemetry responses — both

the WebSocket broadcast from `POST /telemetry` and the `GET

/telemetry/latest` response — as a list. Every consumer (the dashboard and

the Chrome extension) therefore receives the exact same, already-evaluated

alarms instead of re-implementing the threshold rules themselves.

"""

from pydantic import BaseModel, ConfigDict, Field

from backend.app.core.health_status import HealthStatus

_EXAMPLE_ALARM = {

    "rule": "power_critical",

    "level": "Critical",

    "message": "Battery failure",

    "subsystem": "power",

}

class Alarm(BaseModel):

    """A single alarm triggered by one telemetry sample against one rule."""

    rule: str = Field(

        ...,

        description="Stable, machine-readable identifier for the rule that triggered this alarm.",

        examples=["power_critical"],

    )

    level: HealthStatus = Field(

        ...,

        description='Alarm severity — always "Warning" or "Critical" in practice (alarms are never raised for Nominal readings).',

        examples=["Critical"],

    )

    message: str = Field(

        ...,

        description="Short, human-readable description of the alarm.",

        examples=["Battery failure"],

    )

    subsystem: str | None = Field(

        default=None,

        description=(

            "Which subsystem (see backend/app/core/health_status.py) this "

            "alarm was raised for, if it was raised from subsystem health "

            "rather than a numeric telemetry threshold (battery/temperature/"

            "signal/CPU). None for those numeric-threshold alarms. The "

            "frontend uses this to avoid double-logging subsystem alarms in "

            "the Mission Timeline — see pushTimelineEvents() in "

            "frontend/js/dashboard.js, which narrates subsystem transitions "

            "itself, in more detail than a single alarm message can."

        ),

        examples=["power"],

    )

    model_config = ConfigDict(

        json_schema_extra={"examples": [_EXAMPLE_ALARM]}

    )