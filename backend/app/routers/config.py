"""

Configuration endpoint: exposes a minimal, non-sensitive subset of the

application configuration for browser-based clients to bootstrap from.

"""

from fastapi import APIRouter, status

from backend.app.core.config import settings

from backend.app.core.health_status import SUBSYSTEMS, SUBSYSTEM_LABELS

from backend.app.schemas.config import PublicConfig, SubsystemInfo

router = APIRouter(tags=["Configuration"])

@router.get(

    "/config",

    response_model=PublicConfig,

    status_code=status.HTTP_200_OK,

    summary="Get public frontend configuration",

    description=(

        "Returns the subset of application configuration that browser-based "

        "clients (the web dashboard and the Chrome extension) need in order "

        "to bootstrap themselves — the API origin, the WebSocket URL, the "

        "dashboard URL, the simulator's update rate, the satellite name, "

        "and the ordered list of subsystems (with display labels) every "

        "telemetry record reports health for.\n\n"

        "Sensitive or server-internal settings (`DATABASE_URL`, `HOST`, "

        "`LOG_LEVEL`, CORS policy, alarm thresholds) are intentionally "

        "excluded. This endpoint is public and unauthenticated by design "

        "— only frontend-safe values are ever returned."

    ),

    operation_id="get_public_configuration",

    responses={

        200: {

            "description": "The current public configuration.",

            "content": {

                "application/json": {

                    "example": {

                        "project_name": "Mission Control Ground Segment Platform",

                        "project_version": "0.1.0",

                        "api_url": "http://127.0.0.1:8000",

                        "websocket_url": "ws://127.0.0.1:8000/ws",

                        "dashboard_url": "http://127.0.0.1:8080/frontend/dashboard.html",

                        "update_rate": 5.0,

                        "satellite_name": "SD-CUBESAT-001",

                        "subsystems": [

                            {"key": "power", "label": "Power"},

                            {"key": "thermal", "label": "Thermal"},

                            {"key": "communications", "label": "Communications"},

                            {"key": "adcs", "label": "ADCS"},

                            {"key": "payload", "label": "Payload"},

                        ],

                    }

                }

            },

        }

    },

)

def get_config() -> PublicConfig:

    return PublicConfig(

        project_name=settings.PROJECT_NAME,

        project_version=settings.PROJECT_VERSION,

        api_url=settings.API_URL,

        websocket_url=settings.WEBSOCKET_URL,

        dashboard_url=settings.DASHBOARD_URL,

        update_rate=settings.UPDATE_RATE,

        satellite_name=settings.SATELLITE_NAME,

        subsystems=[

            SubsystemInfo(key=subsystem, label=SUBSYSTEM_LABELS[subsystem])

            for subsystem in SUBSYSTEMS

        ],

    )