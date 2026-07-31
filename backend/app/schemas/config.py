"""

Pydantic schema for the public, browser-safe configuration endpoint.

Kept the name `PublicConfig` (rather than the `ConfigResponse` name used

as an example in the brief) since it already exists and is wired into

`routers/config.py` — renaming it would be a needless breaking change for

a documentation-only pass.

"""

from pydantic import BaseModel, ConfigDict, Field

_EXAMPLE_SUBSYSTEMS = [

    {"key": "power", "label": "Power"},

    {"key": "thermal", "label": "Thermal"},

    {"key": "communications", "label": "Communications"},

    {"key": "adcs", "label": "ADCS"},

    {"key": "payload", "label": "Payload"},

]

_EXAMPLE_CONFIG = {

    "project_name": "Mission Control Ground Segment Platform",

    "project_version": "0.1.0",

    "api_url": "http://127.0.0.1:8000",

    "websocket_url": "ws://127.0.0.1:8000/ws",

    "dashboard_url": "http://127.0.0.1:8080/frontend/dashboard.html",

    "update_rate": 5.0,

    "satellite_name": "SD-CUBESAT-001",

    "subsystems": _EXAMPLE_SUBSYSTEMS,

}

class SubsystemInfo(BaseModel):

    """One entry in `PublicConfig.subsystems` — a subsystem's key and its human-readable display label."""

    key: str = Field(

        ...,

        description="Machine-readable subsystem identifier, matching the keys used in a telemetry record's `subsystems` dict.",

        examples=["power"],

    )

    label: str = Field(

        ...,

        description="Human-readable display label for this subsystem.",

        examples=["Power"],

    )

class PublicConfig(BaseModel):

    """

    Public configuration exposed to browser-based frontend applications

    (the web dashboard and the Chrome extension).

    Only non-sensitive, frontend-relevant values are included here.

    Server-internal settings such as `DATABASE_URL`, `HOST`, `LOG_LEVEL`,

    and the CORS policy are intentionally excluded and are never exposed

    by this endpoint.

    """

    project_name: str = Field(

        ...,

        description="Human-readable name of the platform.",

        examples=["Mission Control Ground Segment Platform"],

    )

    project_version: str = Field(

        ...,

        description="Current API/platform version.",

        examples=["0.1.0"],

    )

    api_url: str = Field(

        ...,

        description=(

            "Base REST API origin. Clients append the fixed paths "

            "(e.g. /telemetry, /telemetry/latest) themselves."

        ),

        examples=["http://127.0.0.1:8000"],

    )

    websocket_url: str = Field(

        ...,

        description="Full WebSocket URL for live telemetry updates.",

        examples=["ws://127.0.0.1:8000/ws"],

    )

    dashboard_url: str = Field(

        ...,

        description="URL where the static mission control dashboard is served.",

        examples=["http://127.0.0.1:8080/frontend/dashboard.html"],

    )

    update_rate: float = Field(

        ...,

        gt=0,

        description=(

            "Seconds between simulated telemetry samples. Browser clients "

            "use this to time their own polling so it stays in sync with "

            "the simulator's cadence."

        ),

        examples=[5.0],

    )

    satellite_name: str = Field(

        ...,

        description="Identifier of the satellite currently being simulated.",

        examples=["SD-CUBESAT-001"],

    )

    subsystems: list[SubsystemInfo] = Field(

        ...,

        description=(

            "The five subsystems every telemetry sample reports health for "

            "(see backend/app/core/health_status.py), in display order. "

            "The dashboard's Subsystem Health panel builds its rows from "

            "this list rather than hardcoding subsystem names — see "

            "buildSubsystemHealthRows() in frontend/js/dashboard.js — so "

            "adding a subsystem is a one-line change in health_status.py, "

            "not a change scattered across the frontend too."

        ),

        examples=[_EXAMPLE_SUBSYSTEMS],

    )

    model_config = ConfigDict(json_schema_extra={"examples": [_EXAMPLE_CONFIG]})