"""

Application entrypoint: FastAPI app instance, middleware, router

registration, and OpenAPI/Swagger metadata.

"""

from fastapi import FastAPI

from fastapi.middleware.cors import CORSMiddleware

from backend.app.core.commands import reconcile_after_restart

from backend.app.core.config import settings

from backend.app.core.logging_config import configure_logging, get_logger

from backend.app.routers import config as config_router

from backend.app.routers import health

from backend.app.database.database import engine, Base, SessionLocal

from backend.app.database.migrations import run_migrations

from backend.app.models.command import Command

from backend.app.models.event import Event

from backend.app.models.satellite_state import SatelliteState, ensure_satellite_states

from backend.app.models.telemetry import Telemetry

from backend.app.routers import commands

from backend.app.routers import events

from backend.app.routers import orbit

from backend.app.routers import telemetry

from backend.app.websocket import routes as websocket_routes

# Configure logging before anything else runs, so startup activity

# (migrations, table creation, router registration) is captured in the

# logs too.

configure_logging()

logger = get_logger(__name__)

# Must run BEFORE create_all(): run_migrations() ALTERs an EXISTING

# telemetry table to add any columns a newer version of the Telemetry

# model expects but an older database doesn't have yet (see

# backend/app/database/migrations.py). create_all() only creates tables

# that don't exist at all — it never alters an existing one — so it's the

# right tool for a brand-new database, but the wrong one for an existing

# telemetry.db that predates a model change.

run_migrations(engine)

# Importing Command, Event, SatelliteState, and Telemetry above (not just

# referencing them) is what registers their tables on Base.metadata —

# create_all() only creates tables for model classes that have actually

# been imported/defined somewhere by the time it runs. Simply having a

# model *file* in the project does not register it; the `from ... import`

# above is what does.

Base.metadata.create_all(bind=engine)

logger.info("Database tables verified/created.")

# Startup state initialization/reconciliation — both are idempotent and

# safe to run on every startup, including against a completely fresh

# database (ensure_satellite_states() then just creates every row; there

# is nothing for reconcile_after_restart() to find and fix).

_startup_db = SessionLocal()

try:

    # Creates a default satellite_state row for every satellite in

    # SATELLITE_IDS that doesn't already have one — see

    # backend/app/models/satellite_state.py. Must run before

    # reconcile_after_restart() below, which only touches rows that

    # already exist.

    ensure_satellite_states(_startup_db)

    # Resolves any command left in a non-terminal status, and any

    # satellite left with computer_state=RESTARTING, from a previous

    # backend process that stopped mid-lifecycle — see

    # backend/app/core/commands.py's module docstring ("Restart recovery").

    reconcile_after_restart(_startup_db)

finally:

    _startup_db.close()

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

- **Simulating a command uplink** (`POST /commands`) — a SIMULATION ONLY; no

  real spacecraft are controlled — that changes a satellite's simulated state

  (`GET /satellite-state/{satellite_id}`), which the telemetry simulator then

  reflects in subsequent telemetry

### Real-time updates

In addition to the REST endpoints documented below, this service exposes a

WebSocket endpoint at **`/ws`** that broadcasts, to every connected client,

both newly stored telemetry samples (`"type": "telemetry"`) and command

lifecycle transitions (`"type": "command_update"`) in real time. WebSocket

endpoints are not part of the OpenAPI 3.x specification, so `/ws`

intentionally does not appear as a formal entry in this document. Connect a

WebSocket client directly to the `websocket_url` returned by `GET /config`.

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

        "name": "Orbit",

        "description": (

            "Predicted satellite ground tracks, propagated forward from "

            "each satellite's current position."

        ),

    },

    {

        "name": "Events",

        "description": (

            "Persisted mission events — Battery drops, subsystem "

            "Recoveries, newly-triggered Warning/Critical alarms, and "

            "Command outcomes — retained across restarts, independent of "

            "the live WebSocket telemetry stream."

        ),

    },

    {

        "name": "Commands",

        "description": (

            "Simulated command uplink — SIMULATION ONLY, no real "

            "spacecraft are controlled. Send a command "

            "(`POST /commands`), track its simulated lifecycle "

            "(`GET /commands/{command_id}`), and read a satellite's "

            "resulting current state (`GET /satellite-state/{satellite_id}`), "

            "which the telemetry simulator reflects in subsequent telemetry."

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

app.include_router(events.router)

app.include_router(commands.router)

app.include_router(orbit.router)

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