from sqlalchemy import Column

from sqlalchemy import Integer

from sqlalchemy import String

from sqlalchemy import Float

from sqlalchemy import Boolean

from sqlalchemy import DateTime

from sqlalchemy import JSON

from backend.app.database.database import Base

class Telemetry(Base):

    __tablename__ = "telemetry"

    id = Column(

        Integer,

        primary_key=True,

        index=True

    )

    satellite_id = Column(

        String,

        nullable=False

    )

    latitude = Column(

        Float,

        nullable=False

    )

    longitude = Column(

        Float,

        nullable=False

    )

    altitude = Column(

        Float,

        nullable=False

    )

    velocity = Column(

        Float,

        nullable=False

    )

    timestamp = Column(

        DateTime,

        nullable=False

    )

    battery = Column(

        Float,

        nullable=False

    )

    temperature = Column(

        Float,

        nullable=False

    )

    signal_strength = Column(

        Float,

        nullable=False

    )

    cpu_load = Column(

        Float,

        nullable=False

    )

    status = Column(

        String,

        nullable=False

    )

    # Independent health status for each subsystem (see

    # backend/app/core/health_status.py), stored as JSON —

    # {"power": "Nominal", "thermal": "Warning", ...}. Nullable, unlike

    # every other column here: this column did not exist before the

    # Subsystem Health feature. backend/app/database/migrations.py adds it

    # automatically to an existing telemetry.db on startup, but a migrated

    # column is only ever nullable and does NOT backfill existing rows —

    # every row written *before* that migration ran still reads back as

    # subsystems=None, not an error (see the `_default_missing_subsystems`

    # validator in backend/app/schemas/telemetry.py, and the equivalent

    # defensiveness in backend/app/core/alarms.py). Every row written from

    # this point forward always has a complete dict —

    # TelemetryCreate.subsystems in backend/app/schemas/telemetry.py is a

    # required field.

    subsystems = Column(

        JSON,

        nullable=True

    )

    # Snapshot of this satellite's commanded state (see

    # backend/app/models/satellite_state.py) at the moment this telemetry

    # sample was generated — populated by

    # backend/simulator/telemetry_generator.py, which fetches the current

    # state from `GET /satellite-state/{satellite_id}` before building

    # each packet. This is what makes an executed command's effect

    # (backend/app/core/commands.py) actually observable in subsequent

    # telemetry, not just in the `satellite_state` table itself. Nullable

    # for the same reason `subsystems` above is: these three columns did

    # not exist before the Command Uplink feature, and

    # backend/app/database/migrations.py adds them to an existing

    # telemetry.db without backfilling older rows.

    payload_enabled = Column(

        Boolean,

        nullable=True

    )

    operating_mode = Column(

        String,

        nullable=True

    )

    computer_state = Column(

        String,

        nullable=True

    )