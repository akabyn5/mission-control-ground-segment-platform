"""
WebSocket endpoint for live telemetry broadcasting.

Note: WebSocket routes are not part of the OpenAPI 3.x specification, so
this endpoint intentionally does not — and cannot — appear in the
generated Swagger/OpenAPI documentation. This docstring is the source of
truth for its contract instead; the app-level description in `main.py`
points readers here.
"""

from fastapi import APIRouter
from fastapi import WebSocket
from fastapi import WebSocketDisconnect

from backend.app.core.logging_config import get_logger
from backend.app.websocket.connection_manager import manager

router = APIRouter()
logger = get_logger(__name__)


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """
    Live telemetry stream.

    Protocol
    --------
    - Connect with any standard WebSocket client to `ws://<host>/ws`
      (see the `websocket_url` field returned by `GET /config`).
    - No subscription message or authentication is required.
    - The server does not expect the client to send anything; incoming
      text frames are read but ignored — `receive_text()` is only used
      to detect disconnects.
    - On every successful `POST /telemetry`, the server broadcasts the
      stored record as a JSON text frame to all connected clients. The
      JSON shape matches `TelemetryResponse` in
      `backend/app/schemas/telemetry.py`.
    """

    await manager.connect(websocket)

    try:
        while True:
            await websocket.receive_text()

    except WebSocketDisconnect:
        logger.info("WebSocket connection closed by client")
        manager.disconnect(websocket)