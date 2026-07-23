from fastapi import FastAPI

from backend.app.routers import health
from backend.app.database.database import engine, Base


Base.metadata.create_all(bind=engine)


app = FastAPI(
    title="Mission Control Ground Segment Platform",
    version="0.1.0"
)


app.include_router(
    health.router
)