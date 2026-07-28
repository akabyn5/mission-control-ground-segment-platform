"""
Centralized logging configuration for the Mission Control Ground Segment Platform.

Every backend module (API routers, WebSocket layer, database layer, and the
telemetry simulator) should obtain its logger through `get_logger(__name__)`
instead of using `print()` or the root logger directly. This guarantees a
single, consistent log format and a single place to change logging behavior.

Log output goes to two places:
    - Console (stdout)          -> useful while the server is running
    - logs/mission_control.log  -> persisted between runs, rotated automatically

Rotation policy:
    - Max size per file: 5 MB
    - Backup files kept: 5 (mission_control.log.1 ... mission_control.log.5)

The minimum log level comes from the centralized `settings.LOG_LEVEL`
(sourced from .env) rather than reading the environment directly here —
this file is no longer a second, independent place that parses env vars.
"""

import logging
import logging.handlers

from backend.app.core.config import BASE_DIR, settings

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

# BASE_DIR is imported from config.py rather than recomputed here, so the
# "where is the project root" logic exists in exactly one place.
LOG_DIR = BASE_DIR / "logs"
LOG_FILE = LOG_DIR / "mission_control.log"

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

APP_LOGGER_NAME = "mission_control"
LOG_FORMAT = "%(asctime)s | %(levelname)-8s | %(name)s | %(message)s"
DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

MAX_BYTES = 5 * 1024 * 1024  # 5 MB per log file
BACKUP_COUNT = 5             # keep 5 rotated backups

_configured = False  # guards against attaching duplicate handlers on repeated calls


def configure_logging(level: int | None = None) -> None:
    """
    Configure the dedicated "mission_control" logger with a console handler
    and a rotating file handler. Safe to call multiple times — after the
    first call, subsequent calls are no-ops.
    """
    global _configured

    if _configured:
        return

    if level is None:
        level_name = settings.LOG_LEVEL.upper()
        level = getattr(logging, level_name, logging.INFO)

    LOG_DIR.mkdir(parents=True, exist_ok=True)

    logger = logging.getLogger(APP_LOGGER_NAME)
    logger.setLevel(level)

    # Do not propagate to the root logger. This keeps "mission_control" as a
    # self-contained, dedicated logger instead of relying on root/basicConfig.
    logger.propagate = False

    formatter = logging.Formatter(LOG_FORMAT, datefmt=DATE_FORMAT)

    # Console handler - visible while the server/simulator is running
    console_handler = logging.StreamHandler()
    console_handler.setLevel(level)
    console_handler.setFormatter(formatter)
    logger.addHandler(console_handler)

    # Rotating file handler - persists logs across restarts instead of
    # losing them when the terminal closes.
    file_handler = logging.handlers.RotatingFileHandler(
        filename=LOG_FILE,
        maxBytes=MAX_BYTES,
        backupCount=BACKUP_COUNT,
        encoding="utf-8",
    )
    file_handler.setLevel(level)
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)

    _configured = True

    logger.info("Logging configured (level=%s, file=%s)", logging.getLevelName(level), LOG_FILE)


def get_logger(name: str) -> logging.Logger:
    """
    Return a module-level logger nested under the "mission_control" namespace,
    ensuring configuration has run first.

    Example:
        from backend.app.core.logging_config import get_logger
        logger = get_logger(__name__)
        logger.info("Telemetry stored successfully")
    """
    configure_logging()
    return logging.getLogger(f"{APP_LOGGER_NAME}.{name}")