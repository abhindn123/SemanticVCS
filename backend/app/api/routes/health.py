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


@router.get("/api/v1/knowledge-graph/{repo_id:path}", tags=["Knowledge Graph"])
async def get_knowledge_graph(repo_id: str, request: Request):
    """
    Get Knowledge Graph stats and dependency info for a repository.
    Shows nodes, edges, tables, and blast radius data.
    """
    neo4j = getattr(request.app.state, "neo4j_service", None)
    if not neo4j:
        return {
            "status": "disabled",
            "message": "Knowledge Graph (Neo4j) is not connected",
        }

    stats = await neo4j.get_graph_stats(repo_id)

    return {
        "status": "active",
        "repo_id": repo_id,
        "graph_stats": stats,
    }


@router.get("/api/v1/knowledge-graph/{repo_id:path}/risk/{file_path:path}", tags=["Knowledge Graph"])
async def get_file_risk(repo_id: str, file_path: str, request: Request):
    """
    Get dependency-based risk for a specific file.
    Shows shared reverted tables, APIs, and blast radius.
    """
    neo4j = getattr(request.app.state, "neo4j_service", None)
    if not neo4j:
        return {"status": "disabled"}

    risk = await neo4j.get_dependency_risk(file_path=file_path, repo_id=repo_id)
    return {
        "status": "active",
        "file_path": file_path,
        "risk": risk,
    }


@router.get("/api/v1/blast-radius/{repo_id:path}", tags=["Knowledge Graph"])
async def get_blast_radius(repo_id: str, request: Request, file: str = ""):
    """
    Get blast radius for a file — what other files could break.
    Shows dependency tree with specific functions used.
    """
    neo4j = getattr(request.app.state, "neo4j_service", None)
    if not neo4j:
        return {"status": "disabled", "blast_radius": {"dependent_files": [], "total_affected": 0}}

    if not file:
        return {"status": "error", "message": "file query parameter required"}

    try:
        blast = await neo4j.get_blast_radius(file_path=file, repo_id=repo_id)
        return {"status": "active", **blast}
    except Exception as e:
        return {"status": "error", "message": str(e), "blast_radius": {"dependent_files": [], "total_affected": 0}}
