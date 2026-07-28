"""
Pydantic schema for the /health endpoint.
"""

from pydantic import BaseModel, ConfigDict, Field


class HealthResponse(BaseModel):
    """Response returned by the health check endpoint."""

    status: str = Field(
        ...,
        description=(
            "Overall service health. Currently always \"ok\" — this endpoint "
            "does not perform deep dependency checks (e.g. database "
            "connectivity); it only confirms that the process is running "
            "and able to handle HTTP requests."
        ),
        examples=["ok"],
    )

    model_config = ConfigDict(
        json_schema_extra={"examples": [{"status": "ok"}]}
    )