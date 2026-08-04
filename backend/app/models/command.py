from enum import StrEnum

from sqlalchemy import Column

from sqlalchemy import Integer

from sqlalchemy import String

from sqlalchemy import DateTime

from sqlalchemy import JSON

from backend.app.database.database import Base

class CommandType(StrEnum):

    """

    The four commands this project's simulated uplink supports. A StrEnum

    (like backend/app/core/health_status.py's HealthStatus) so Pydantic

    validates a `POST /commands` request's `command` field against exactly

    these four values and rejects anything else, while still behaving as

    an ordinary string everywhere it's used.

    """

    ENABLE_PAYLOAD = "ENABLE_PAYLOAD"

    RESTART_COMPUTER = "RESTART_COMPUTER"

    CHANGE_MODE = "CHANGE_MODE"

    ENTER_SAFE_MODE = "ENTER_SAFE_MODE"

class CommandStatus(StrEnum):

    """

    A command's position in its simulated uplink lifecycle — see

    backend/app/core/commands.py, the only place that advances a command

    from one of these to the next.

    """

    QUEUED = "QUEUED"

    SENT = "SENT"

    ACKNOWLEDGED = "ACKNOWLEDGED"

    EXECUTED = "EXECUTED"

    FAILED = "FAILED"

class Command(Base):

    """

    A single command sent to a satellite, and its complete simulated

    uplink lifecycle — persisted so command history survives an

    application restart, independent of

    backend/simulator/satellite_state.py's in-memory *current* simulated

    state, which does not (see that module's docstring for why those are

    deliberately different things).

    """

    __tablename__ = "commands"

    id = Column(

        Integer,

        primary_key=True,

        index=True

    )

    satellite_id = Column(

        String,

        nullable=False,

        index=True

    )

    # "ENABLE_PAYLOAD" | "RESTART_COMPUTER" | "CHANGE_MODE" | "ENTER_SAFE_MODE"

    command_type = Column(

        String,

        nullable=False,

        index=True

    )

    # e.g. {"mode": "SAFE"} for CHANGE_MODE; null/empty for every other

    # command type, which take no parameters — see

    # backend/app/schemas/commands.py's CommandCreate validator for the

    # exact rule.

    parameters = Column(

        JSON,

        nullable=True

    )

    # "QUEUED" | "SENT" | "ACKNOWLEDGED" | "EXECUTED" | "FAILED"

    status = Column(

        String,

        nullable=False,

        index=True

    )

    # When the command was received and queued (== the initial row's

    # creation time; this project executes commands synchronously within

    # one request, so there's no meaningful gap between "queued" and "sent"

    # worth a separate column for — see backend/app/core/commands.py).

    created_at = Column(

        DateTime,

        nullable=False

    )

    acknowledged_at = Column(

        DateTime,

        nullable=True

    )

    executed_at = Column(

        DateTime,

        nullable=True

    )

    # Human-readable reason, populated only when status == FAILED — e.g.

    # "Computer is already restarting" (see backend/app/core/commands.py

    # for the one currently-defined failure case).

    failure_reason = Column(

        String,

        nullable=True

    )