"""

Centralized application configuration for the Mission Control Ground

Segment Platform.

Every configurable value in the project (URLs, ports, database location,

log level, CORS policy, simulator cadence, etc.) is declared exactly once,

here, as a field on the `Settings` class. Nothing else in the codebase

should hardcode a URL, port, or similar deployment-specific value — it

should import `settings` from this module instead.

Why Pydantic Settings instead of plain python-dotenv:

    - Values are typed and validated at import time. A malformed PORT or

      CORS_CREDENTIALS value fails fast at startup, not deep inside a

      request handler during a demo.

    - It matches the typed-schema style already used elsewhere in this

      project (backend/app/schemas/telemetry.py), so there's one mental

      model for "typed data from the outside world" across the codebase.

    - `env_file=".env"` handles loading and parsing; no manual

      os.getenv() + str -> int/bool casting scattered across files.

    - A single module-level `settings` instance is the one source of

      truth, imported wherever it's needed (routers, the simulator,

      logging config) without re-parsing .env repeatedly.

Plain python-dotenv was considered and rejected: it would still require

hand-written type conversion and validation for every field, which is

exactly the duplication this refactor is meant to remove.

"""

from pathlib import Path

from typing import List

from pydantic_settings import BaseSettings, SettingsConfigDict

# Project root = 4 levels up from this file:

# backend/app/core/config.py -> backend/app/core -> backend/app -> backend -> <root>

# Shared with logging_config.py so the "where is the project root" logic

# exists in exactly one place.

BASE_DIR = Path(__file__).resolve().parents[3]

class Settings(BaseSettings):

    """

    Single source of truth for all environment-specific configuration.

    Values are loaded from the `.env` file at the project root. The

    defaults below reproduce today's previously-hardcoded values, so an

    existing checkout keeps working unmodified even without a `.env` file.

    """

    # --- Project metadata -------------------------------------------------

    PROJECT_NAME: str = "Mission Control Ground Segment Platform"

    PROJECT_VERSION: str = "0.1.0"

    # --- Server bind address ----------------------------------------------

    # What uvicorn binds to. Not necessarily what clients use to reach the

    # server (see API_URL / WEBSOCKET_URL below) — e.g. a server can bind

    # 0.0.0.0 while clients still connect via a concrete address.

    HOST: str = "127.0.0.1"

    PORT: int = 8000

    # --- Client-facing URLs -------------------------------------------------

    # Base REST origin. Callers append the fixed, non-configurable paths

    # (/telemetry, /telemetry/latest, /health) themselves — only the origin

    # changes between environments, the API contract does not.

    API_URL: str = "http://127.0.0.1:8000"

    # Full WebSocket URL. There is exactly one WS endpoint (/ws), so unlike

    # API_URL there is no separate "base + path" to construct.

    WEBSOCKET_URL: str = "ws://127.0.0.1:8000/ws"

    # Where the static dashboard is served from (e.g. VS Code Live Server).

    # Not in the required minimum set, but needed to remove the remaining

    # hardcoded URL from the Chrome extension.

    DASHBOARD_URL: str = "http://127.0.0.1:8080/frontend/dashboard.html"

    # --- Database -----------------------------------------------------------

    DATABASE_URL: str = "sqlite:///./telemetry.db"

    # --- Logging --------------------------------------------------------

    LOG_LEVEL: str = "INFO"

    # --- Telemetry simulator ----------------------------------------------

    UPDATE_RATE: float = 5.0  # seconds between simulated telemetry samples

    SATELLITE_NAME: str = "SD-CUBESAT-001"

    # --- Alarm thresholds ---------------------------------------------------

    # Used by backend/app/core/alarms.py to evaluate every incoming

    # telemetry sample. Battery has two severities on the same metric — a

    # softer Warning band above a harder Critical floor — so both are

    # configurable independently. The rest are single Warning thresholds.

    # Defaults are set comfortably outside the ranges

    # backend/simulator/telemetry_generator.py currently generates, so the

    # simulator's normal output stays alarm-free; these exist to react

    # correctly to real (or future non-simulated) telemetry that actually

    # approaches these limits, not to fire routinely today.

    BATTERY_CRITICAL_THRESHOLD: float = 20.0

    BATTERY_WARNING_THRESHOLD: float = 30.0

    TEMPERATURE_WARNING_THRESHOLD: float = 35.0

    SIGNAL_WARNING_THRESHOLD: float = 50.0

    CPU_WARNING_THRESHOLD: float = 85.0

    # --- Event log ----------------------------------------------------

    # Minimum battery drop (in percentage points, versus the satellite's

    # previous sample) required to persist a Battery event — see the

    # "Battery event threshold" discussion in backend/app/core/events.py

    # for why this isn't "any decrease at all." Independent of

    # BATTERY_WARNING_THRESHOLD/BATTERY_CRITICAL_THRESHOLD above, which

    # are absolute levels, not deltas.

    BATTERY_DROP_EVENT_THRESHOLD: float = 2.0

    # --- CORS ----------------------------------------------------------

    # Stored as a plain comma-separated string (the natural .env format),

    # not List[str]: pydantic-settings attempts to JSON-decode env values

    # for list-typed fields before any custom validator runs, which would

    # reject a plain "a,b" string. `allow_origins_list` below is the

    # single place that turns this into the list CORSMiddleware needs.

    ALLOW_ORIGINS: str = "http://127.0.0.1:8080,http://localhost:8080"

    CORS_CREDENTIALS: bool = True

    @property

    def allow_origins_list(self) -> List[str]:

        """CORSMiddleware wants a list; .env stores a comma-separated string."""

        return [origin.strip() for origin in self.ALLOW_ORIGINS.split(",") if origin.strip()]

    model_config = SettingsConfigDict(

        env_file=str(BASE_DIR / ".env"),

        env_file_encoding="utf-8",

        case_sensitive=True,

        extra="ignore",

    )

# Instantiated once at import time. Every other module imports this

# instance rather than constructing its own Settings().

settings = Settings()