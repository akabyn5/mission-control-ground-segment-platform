"""

Pydantic schemas for the /orbit/tracks endpoint.

`TrackPoint` is a single predicted ground-track sample — latitude and
longitude only, matching what `get_predicted_track()` in
`backend/simulator/orbit_propagator.py` returns. Altitude and velocity are
intentionally omitted here for the same reason they're omitted there: this
data is used to draw a predicted ground track on a 2D map, which only
needs the sub-satellite point.

`OrbitTracksResponse` describes the response shape of `GET /orbit/tracks`
so Swagger/OpenAPI documents it precisely instead of showing an untyped
dict. There is no request schema in this file: the endpoint takes no query
parameters — horizon and step are fixed internal constants in
`backend/app/routers/orbit.py`, not client-supplied input — so there is
nothing to validate on the way in.

"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

# Example payload reused across TrackPoint and OrbitTracksResponse so
# Swagger shows a consistent, realistic example everywhere.
_EXAMPLE_TRACK_POINT = {

    "latitude": 8.9832,

    "longitude": -79.5199,

}

_EXAMPLE_ORBIT_TRACKS = {

    "generated_at": "2026-07-29T18:35:12Z",

    "tracks": {

        "SD-CUBESAT-001": [

            {"latitude": 8.9832, "longitude": -79.5199},

            {"latitude": 9.1023, "longitude": -79.3011},

        ]

    },

}

class TrackPoint(BaseModel):

    """A single predicted ground-track point (latitude/longitude only)."""

    latitude: float = Field(

        ...,

        ge=-90,

        le=90,

        description="Predicted sub-satellite point latitude, in decimal degrees (WGS84).",

        examples=[8.9832],

    )

    longitude: float = Field(

        ...,

        ge=-180,

        le=180,

        description="Predicted sub-satellite point longitude, in decimal degrees (WGS84).",

        examples=[-79.5199],

    )

    model_config = ConfigDict(

        json_schema_extra={"examples": [_EXAMPLE_TRACK_POINT]}

    )

class OrbitTracksResponse(BaseModel):

    """The predicted ground tracks for every satellite in the fleet, as returned by `GET /orbit/tracks`."""

    generated_at: datetime = Field(

        ...,

        description="UTC timestamp when these tracks were computed. Unchanged while the response is served from cache.",

        examples=["2026-07-29T18:35:12Z"],

    )

    tracks: dict[str, list[TrackPoint]] = Field(

        ...,

        description="Predicted ground track per satellite, keyed by satellite_id.",

        examples=[_EXAMPLE_ORBIT_TRACKS["tracks"]],

    )

    model_config = ConfigDict(

        json_schema_extra={"examples": [_EXAMPLE_ORBIT_TRACKS]}

    )