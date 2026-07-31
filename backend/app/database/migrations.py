"""

Minimal, hand-rolled schema migration for SQLite.

This project has no Alembic (or other migration framework) — it relies

entirely on SQLAlchemy's `Base.metadata.create_all()` in

`backend/app/main.py`, which only creates tables that don't exist yet and

never alters existing ones. That's fine as long as every checkout starts

from a fresh database, but it silently breaks an EXISTING `telemetry.db`

the moment a column is added to a model whose table already has rows:

SQLAlchemy will happily try to SELECT the new column, SQLite will report

"no such column", and every telemetry endpoint starts failing.

`run_migrations()` below is a deliberately small, explicit alternative to

pulling in a full migration framework for a single-table hackathon

project: for each `(table, column, SQL type)` in `_MIGRATIONS`, it checks

whether the column already exists (via SQLAlchemy's `Inspector`, which

reads SQLite's `PRAGMA table_info` under the hood) and, if not, adds it

with `ALTER TABLE ... ADD COLUMN`. Called once from `backend/app/main.py`,

*before* `Base.metadata.create_all()` — so that call still handles

creating the table from scratch for a brand-new database, and this

function only ever ALTERs a table that already existed going in.

This intentionally does NOT handle: column removal, column type changes,

or data backfilling — an added column is only ever nullable and starts

NULL on every pre-existing row (see `backend/app/models/telemetry.py`'s

`subsystems = Column(JSON, nullable=True)`, and the corresponding

`_default_missing_subsystems` validator in

`backend/app/schemas/telemetry.py`, which is what makes NULL a safe,

handled value rather than a crash). It also only supports SQLite. If this

project ever needs more than that, that's the signal to adopt Alembic

instead of growing this file.

"""

from sqlalchemy import inspect, text

from sqlalchemy.engine import Engine

from backend.app.core.logging_config import get_logger

logger = get_logger(__name__)

# (table_name, column_name, SQL column type) for every column added to an

# existing model after that model's table may already have been created in

# someone's checkout. Add a new entry here — not a schema rewrite — the

# next time this happens.

_MIGRATIONS = [

    ("telemetry", "subsystems", "JSON"),

]

def run_migrations(engine: Engine) -> None:

    """

    Adds any columns listed in `_MIGRATIONS` that don't already exist on

    their table. Safe to call on every startup, including against a

    brand-new (table-less) database: `inspector.has_table()` guards each

    entry, since `Base.metadata.create_all()` (called by the caller, right

    after this) is what creates the table itself for a fresh database —

    this function only ever ALTERs a table that already exists.

    """

    inspector = inspect(engine)

    for table_name, column_name, column_type in _MIGRATIONS:

        if not inspector.has_table(table_name):

            # Fresh database — Base.metadata.create_all() will create this

            # table, with the column already included since it's part of

            # the current model. Nothing to migrate.

            continue

        existing_columns = {column["name"] for column in inspector.get_columns(table_name)}

        if column_name in existing_columns:

            continue

        logger.warning(

            "Migrating database: adding missing column %s.%s",

            table_name,

            column_name

        )

        with engine.begin() as connection:

            connection.execute(

                text(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_type}")

            )