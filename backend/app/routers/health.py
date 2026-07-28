"""
System endpoints: health checks and other operational status routes.
"""

from fastapi import APIRouter, status

from backend.app.schemas.health import HealthResponse

router = APIRouter(tags=["System"])


@router.get(
    "/health",
    response_model=HealthResponse,
    status_code=status.HTTP_200_OK,
    summary="Health check",
    description=(
        "Lightweight liveness check used by monitoring systems, reverse "
        "proxies, and orchestration/deployment platforms to verify that "
        "the backend process is running and able to handle HTTP requests. "
        "This check does not verify downstream dependencies such as the "
        "database."
    ),
    operation_id="health_check",
    responses={
        200: {
            "description": "The service is running.",
            "content": {"application/json": {"example": {"status": "ok"}}},
        }
    },
)
def health_check() -> HealthResponse:
    return HealthResponse(status="ok")