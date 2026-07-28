"""
Application entrypoint: FastAPI app instance, middleware, router
registration, and OpenAPI/Swagger metadata.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.app.core.config import settings
from backend.app.core.logging_config import configure_logging, get_logger
from backend.app.routers import config as config_router
from backend.app.routers import health
from backend.app.database.database import engine, Base
from backend.app.models.telemetry import Telemetry
from backend.app.routers import telemetry
from backend.app.websocket import routes as websocket_routes

# Configure logging before anything else runs, so startup activity
# (table creation, router registration) is captured in the logs too.
configure_logging()
logger = get_logger(__name__)

Base.metadata.create_all(bind=engine)
logger.info("Database tables verified/created.")

# ---------------------------------------------------------------------------
# OpenAPI / Swagger metadata
# ---------------------------------------------------------------------------

API_DESCRIPTION = """
Mission Control Ground Segment Platform is a backend service that simulates
a satellite ground station. It is capable of:

- **Receiving satellite telemetry** via a REST API (`POST /telemetry`)
- **Persisting mission telemetry** to a database
- **Broadcasting live telemetry updates** to connected clients over WebSockets
- **Serving public, non-sensitive configuration** (`GET /config`) so browser-based
  clients — the web dashboard and the companion Chrome extension — can bootstrap
  themselves without hardcoded URLs

### Real-time updates

In addition to the REST endpoints documented below, this service exposes a
WebSocket endpoint at **`/ws`** that broadcasts every newly stored telemetry
sample to connected clients in real time. WebSocket endpoints are not part
of the OpenAPI 3.x specification, so `/ws` intentionally does not appear as
a formal entry in this document. Connect a WebSocket client directly to the
`websocket_url` returned by `GET /config`.
"""

# Tag descriptions shown above each group of endpoints in Swagger UI.
TAGS_METADATA = [
    {
        "name": "System",
        "description": (
            "Health and operational status endpoints used by monitoring "
            "systems, reverse proxies, and deployment/orchestration tooling."
        ),
    },
    {
        "name": "Telemetry",
        "description": (
            "Receive satellite telemetry and retrieve the most recently "
            "stored sample."
        ),
    },
    {
        "name": "Configuration",
        "description": (
            "Public, non-sensitive configuration values used by "
            "browser-based clients to bootstrap themselves."
        ),
    },
]

app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.PROJECT_VERSION,
    description=API_DESCRIPTION,
    openapi_tags=TAGS_METADATA,
    # NOTE: contact/license/terms_of_service below are placeholders. They
    # satisfy FastAPI's metadata fields but reference no real page — replace
    # them with the project's actual contact, license, and terms before
    # this API is published anywhere outside the hackathon/internal context.
    contact={
        "name": "Space Dogs — International Projects",
        "url": "https://github.com/akabyn5/mission-control-ground-segment-platform.git",
        # NOTE: an "email" key is also supported here, but was left out on
        # purpose — FastAPI validates it as EmailStr, which pulls in the
        # optional `email-validator` package. Adding a new dependency for
        # metadata alone is out of scope for this documentation pass.
    },
    license_info={
        "name": "See LICENSE file in the project repository",
    },
    terms_of_service=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allow_origins_list,
    allow_credentials=settings.CORS_CREDENTIALS,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(telemetry.router)
app.include_router(websocket_routes.router)
app.include_router(config_router.router)

logger.info("%s startup complete.", settings.PROJECT_NAME)


if __name__ == "__main__":
    # Allows `python -m backend.app.main` as an alternative to the
    # `uvicorn backend.app.main:app --reload` CLI invocation, using the
    # same centralized HOST/PORT settings instead of CLI flags.
    import uvicorn

    uvicorn.run(
        "backend.app.main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=True,
    )