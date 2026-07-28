from sqlalchemy import Column
from sqlalchemy import Integer
from sqlalchemy import String
from sqlalchemy import Float
from sqlalchemy import DateTime

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