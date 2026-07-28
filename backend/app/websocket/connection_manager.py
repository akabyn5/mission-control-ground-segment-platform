from fastapi import WebSocket

from backend.app.core.logging_config import get_logger

logger = get_logger(__name__)


class ConnectionManager:
    """
    Tracks every active WebSocket client and broadcasts telemetry
    messages to all of them.
    """

    def __init__(self):
        # List of every connected WebSocket client
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        """
        Accept a new WebSocket connection and store it in the active list.
        """
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(
            "WebSocket client connected (active_clients=%d)",
            len(self.active_connections)
        )

    def disconnect(self, websocket: WebSocket):
        """
        Remove a disconnected client.
        """
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            logger.info(
                "WebSocket client disconnected (active_clients=%d)",
                len(self.active_connections)
            )

    async def broadcast(self, message: dict):
        """
        Send the same JSON message to every connected client. Clients that
        fail to receive the message are treated as dead and removed.
        """
        if not self.active_connections:
            logger.warning("No WebSocket clients connected. Skipping broadcast.")
            return

        logger.info(
            "Broadcasting telemetry to %d client(s)",
            len(self.active_connections)
        )

        dead = []

        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception:
                logger.exception(
                    "Failed to send telemetry to a WebSocket client. Marking as dead."
                )
                dead.append(connection)

        for connection in dead:
            self.disconnect(connection)


manager = ConnectionManager()