from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

from backend.app.core.config import settings

# NOTE: `check_same_thread=False` is a SQLite-specific connect argument.
# If DATABASE_URL is ever pointed at a different engine (e.g. Postgres),
# this argument would need to become conditional on the URL scheme. Left
# as-is here since changing the database backend is out of scope for this
# configuration refactor.
engine = create_engine(
    settings.DATABASE_URL,
    connect_args={
        "check_same_thread": False
    }
)

SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine
)

Base = declarative_base()