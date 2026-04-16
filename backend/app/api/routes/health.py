"""
Health Check endpoint.

Used by Railway, monitoring services, and the VS Code extension
to verify the backend is running and all services are connected.
"""

import time

from fastapi import APIRouter, Request

from app.models.schemas import HealthResponse
from app.api.deps import get_qdrant, get_supabase, get_redis

router = APIRouter()


@router.get("/health", response_model=HealthResponse, tags=["Health"])
async def health_check(request: Request) -> HealthResponse:
    """
    Check the health of all services.

    Returns the connection status of Qdrant, Supabase, Redis,
    and whether the ML model is loaded.
    """
    start_time = request.app.state.start_time
    uptime = time.time() - start_time

    # Check each service
    qdrant_service = get_qdrant(request)
    supabase_service = get_supabase(request)
    redis_service = get_redis(request)

    qdrant_info = await qdrant_service.get_collection_info()
    supabase_status = await supabase_service.health_check()
    redis_status = await redis_service.health_check()

    # Check if embedder is loaded
    model_loaded = hasattr(request.app.state, "embedder") and request.app.state.embedder is not None

    # Determine overall status
    all_connected = (
        qdrant_info.get("status") == "connected"
        and supabase_status == "connected"
        and redis_status == "connected"
    )

    return HealthResponse(
        status="healthy" if all_connected else "degraded",
        qdrant=qdrant_info.get("status", "unknown"),
        supabase=supabase_status,
        redis=redis_status,
        model_loaded=model_loaded,
        uptime_seconds=round(uptime, 2),
    )
