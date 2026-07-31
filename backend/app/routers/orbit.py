"""

Endpoint for predicted satellite ground tracks.

`GET /orbit/tracks` returns a predicted ground track for every satellite
in the fleet, propagated forward from each satellite's current position
using `get_predicted_track()` in `backend/simulator/orbit_propagator.py`.

The prediction horizon and step are fixed internal constants rather than
client-supplied query parameters, so the endpoint takes no input and its
response can be served from a single in-memory cache entry instead of a
cache keyed on request parameters.

"""

import time

from datetime import datetime, UTC

from fastapi import APIRouter, status

from backend.app.core.logging_config import get_logger

from backend.app.schemas.orbit import OrbitTracksResponse, TrackPoint

from backend.simulator.fleet import SATELLITE_OFFSETS

from backend.simulator.orbit_propagator import get_predicted_track

router = APIRouter(tags=["Orbit"])

logger = get_logger(__name__)

# Internal constants — deliberately not exposed as query parameters: the
# endpoint always predicts the same fixed horizon at the same fixed
# resolution, so every client sees identical tracks and the in-memory
# cache below can use a single cache entry instead of keying on
# client-supplied parameters.
DEFAULT_HORIZON_MINUTES = 90

DEFAULT_STEP_MINUTES = 1

CACHE_TTL_SECONDS = 30

# In-memory cache holding the single (parameterless) response this
# endpoint ever produces. `_cache_timestamp` uses time.monotonic(), not
# wall-clock time, so the TTL is immune to system clock adjustments.
_cache: OrbitTracksResponse | None = None

_cache_timestamp: float | None = None

def _compute_tracks() -> OrbitTracksResponse:

    """

    Recomputes the predicted ground track for every satellite in the
    fleet, using each satellite's fixed orbital offset from
    backend/simulator/fleet.py.

    """

    tracks = {

        satellite_id: [

            TrackPoint(**point)

            for point in get_predicted_track(

                offset_minutes=offset_minutes,

                horizon_minutes=DEFAULT_HORIZON_MINUTES,

                step_minutes=DEFAULT_STEP_MINUTES,

            )

        ]

        for satellite_id, offset_minutes in SATELLITE_OFFSETS.items()

    }

    return OrbitTracksResponse(

        generated_at=datetime.now(UTC),

        tracks=tracks,

    )

@router.get(

    "/orbit/tracks",

    response_model=OrbitTracksResponse,

    status_code=status.HTTP_200_OK,

    summary="Get predicted ground tracks for the fleet",

    description=(

        "Returns a predicted ground track — a series of latitude/longitude "

        "points — for every satellite in the fleet, looking "

        f"{DEFAULT_HORIZON_MINUTES} minutes into the future at "

        f"{DEFAULT_STEP_MINUTES}-minute resolution.\n\n"

        "The horizon and step are fixed internal constants rather than "

        "query parameters, so this endpoint takes no input. Results are "

        f"cached in memory for {CACHE_TTL_SECONDS} seconds; repeated calls "

        "within that window return the same cached response instead of "

        "recomputing the propagation."

    ),

    operation_id="get_orbit_tracks",

    responses={

        200: {

            "description": "Predicted ground tracks for every satellite in the fleet.",

            "content": {

                "application/json": {

                    "example": {

                        "generated_at": "2026-07-29T18:35:12Z",

                        "tracks": {

                            "SD-CUBESAT-001": [

                                {"latitude": 8.9832, "longitude": -79.5199},

                                {"latitude": 9.1023, "longitude": -79.3011},

                            ]

                        },

                    }

                }

            },

        },

    },

)

def get_orbit_tracks() -> OrbitTracksResponse:

    global _cache, _cache_timestamp

    now = time.monotonic()

    if _cache is not None and _cache_timestamp is not None:

        if now - _cache_timestamp < CACHE_TTL_SECONDS:

            logger.info(

                "Serving cached orbit tracks (age=%.1fs)",

                now - _cache_timestamp

            )

            return _cache

    logger.info("Recomputing orbit tracks (cache expired or empty)")

    _cache = _compute_tracks()

    _cache_timestamp = now

    return _cache