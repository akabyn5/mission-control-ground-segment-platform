"""

Pydantic schemas for the simulated command uplink API.

`CommandCreate` is the request body accepted by `POST /commands`.

`CommandResponse` describes a single command's stored state, as returned

by `POST /commands` (immediately after being queued — see

backend/app/routers/commands.py for why this returns 202 with status

QUEUED rather than waiting for the full simulated lifecycle to finish),

`GET /commands`, and `GET /commands/{command_id}`, and is also embedded

in the "command_update" WebSocket message broadcast after every lifecycle

stage transition. `SatelliteStateResponse` describes a satellite's current

simulated state, as returned by `GET /satellite-state/{satellite_id}` —

the same endpoint the telemetry simulator itself polls before building

each telemetry packet (see backend/simulator/telemetry_generator.py).

"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, model_validator

from backend.app.models.command import CommandStatus, CommandType

from backend.app.models.satellite_state import ComputerState, OperatingMode

_EXAMPLE_CHANGE_MODE = {

    "satellite_id": "SD-CUBESAT-001",

    "command": "CHANGE_MODE",

    "parameters": {"mode": "SAFE"},

}

_EXAMPLE_COMMAND_RESPONSE = {

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

_EXAMPLE_SATELLITE_STATE = {

    "satellite_id": "SD-CUBESAT-001",

    "operating_mode": "NOMINAL",

    "payload_enabled": True,

    "computer_state": "NORMAL",

    "updated_at": "2026-07-27T18:35:12Z",

}

class CommandCreate(BaseModel):

    """

    A single command directed at one satellite.

    Parameter validation rule (deliberately strict, not "safely ignore

    unknown fields"): `CHANGE_MODE` requires `parameters` to be exactly

    `{"mode": <a valid OperatingMode>}` — nothing more, nothing less.

    Every other command type takes no parameters at all; supplying any

    for them is rejected rather than silently ignored.

    """

    satellite_id: str = Field(

        ...,

        min_length=1,

        description="Which satellite this command is directed at. Must be a satellite in the configured fleet (see backend/simulator/fleet.py) — an unknown satellite_id is rejected with 404, not a validation error, since the string itself is well-formed.",

        examples=["SD-CUBESAT-001"],

    )

    command: CommandType = Field(

        ...,

        description="Which command to send. One of ENABLE_PAYLOAD, RESTART_COMPUTER, CHANGE_MODE, ENTER_SAFE_MODE.",

        examples=["CHANGE_MODE"],

    )

    parameters: dict | None = Field(

        None,

        description='Command-specific parameters. Required and validated for CHANGE_MODE (`{"mode": "NOMINAL" | "SAFE"}`); must be omitted or empty for every other command.',

        examples=[{"mode": "SAFE"}],

    )

    @model_validator(mode="after")

    def _validate_parameters(self) -> "CommandCreate":

        if self.command == CommandType.CHANGE_MODE:

            if not self.parameters or set(self.parameters.keys()) != {"mode"}:

                raise ValueError(

                    'CHANGE_MODE requires parameters to be exactly {"mode": "NOMINAL" | "SAFE"}'

                )

            try:

                OperatingMode(self.parameters["mode"])

            except ValueError:

                valid = [mode.value for mode in OperatingMode]

                raise ValueError(

                    f"Invalid mode {self.parameters['mode']!r} — must be one of {valid}"

                )

        elif self.parameters:

            raise ValueError(

                f"{self.command} does not accept parameters, got {list(self.parameters.keys())}"

            )

        return self

    model_config = ConfigDict(

        json_schema_extra={"examples": [_EXAMPLE_CHANGE_MODE]}

    )

class CommandResponse(BaseModel):

    """A single command's current lifecycle state."""

    id: int = Field(..., description="Database identifier of the command.", examples=[5])

    satellite_id: str = Field(..., description="Satellite this command was directed at.", examples=["SD-CUBESAT-001"])

    command_type: str = Field(..., description="Which command this is.", examples=["CHANGE_MODE"])

    parameters: dict | None = Field(None, description="Command-specific parameters, if any.", examples=[{"mode": "SAFE"}])

    status: CommandStatus = Field(..., description="Current position in the simulated uplink lifecycle.", examples=["QUEUED"])

    failure_reason: str | None = Field(None, description="Human-readable reason, populated only when status is FAILED.", examples=[None])

    created_at: datetime = Field(..., description="When the command was received and queued.", examples=["2026-07-27T18:35:12Z"])

    acknowledged_at: datetime | None = Field(None, description="When the simulated uplink acknowledged the command, if it has been.", examples=[None])

    executed_at: datetime | None = Field(None, description="When the command finished executing (successfully or not), if it has.", examples=[None])

    model_config = ConfigDict(

        from_attributes=True,

        json_schema_extra={"examples": [_EXAMPLE_COMMAND_RESPONSE]}

    )

class SatelliteStateResponse(BaseModel):

    """A satellite's current simulated state — the effect of every EXECUTED command sent to it so far."""

    satellite_id: str = Field(..., description="Which satellite this state belongs to.", examples=["SD-CUBESAT-001"])

    operating_mode: OperatingMode = Field(..., description="Current commanded operating mode.", examples=["NOMINAL"])

    payload_enabled: bool = Field(..., description="Whether the payload is currently enabled.", examples=[True])

    computer_state: ComputerState = Field(..., description="Current flight-computer state — NORMAL, or RESTARTING during a simulated RESTART_COMPUTER command.", examples=["NORMAL"])

    updated_at: datetime = Field(..., description="When this state last changed.", examples=["2026-07-27T18:35:12Z"])

    model_config = ConfigDict(

        from_attributes=True,

        json_schema_extra={"examples": [_EXAMPLE_SATELLITE_STATE]}

    )