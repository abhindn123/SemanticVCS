"""
API Dependency Injection.

Provides FastAPI dependencies for accessing services (Qdrant, Supabase, Redis)
and handling authentication.
"""

import logging
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request, status

from app.services.qdrant_service import QdrantService
from app.services.supabase_service import SupabaseService
from app.services.redis_service import RedisService
from app.services.neo4j_service import Neo4jService

logger = logging.getLogger(__name__)


# === Service Dependencies ===

def get_qdrant(request: Request) -> QdrantService:
    """Get the Qdrant service from app state."""
    return request.app.state.qdrant_service


def get_supabase(request: Request) -> SupabaseService:
    """Get the Supabase service from app state."""
    return request.app.state.supabase_service


def get_redis(request: Request) -> RedisService:
    """Get the Redis service from app state."""
    return request.app.state.redis_service


def get_neo4j(request: Request) -> Neo4jService:
    """Get the Neo4j service from app state."""
    return request.app.state.neo4j_service


# === Authentication ===

async def get_current_user(
    authorization: Annotated[str, Header()],
    supabase: SupabaseService = Depends(get_supabase),
    redis: RedisService = Depends(get_redis),
) -> dict:
    """
    Validate API key from Authorization header.

    Expected format: 'Bearer svcs_xxxxxxxxxxxxx'
    """
    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authorization header. Expected: Bearer <api_key>",
        )

    api_key = authorization.replace("Bearer ", "").strip()

    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="API key is required",
        )

    # Check rate limit (fail-open: if Redis is down, allow the request)
    try:
        is_allowed, remaining = await redis.check_rate_limit(api_key)
        if not is_allowed:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Rate limit exceeded. Please wait and try again.",
                headers={"X-RateLimit-Remaining": "0"},
            )
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"Rate limit check failed (allowing request): {e}")

    # Look up user by API key
    user = await supabase.get_user_by_api_key(api_key)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key",
        )

    return user


# Type aliases for cleaner route signatures
QdrantDep = Annotated[QdrantService, Depends(get_qdrant)]
SupabaseDep = Annotated[SupabaseService, Depends(get_supabase)]
RedisDep = Annotated[RedisService, Depends(get_redis)]
Neo4jDep = Annotated[Neo4jService, Depends(get_neo4j)]
CurrentUser = Annotated[dict, Depends(get_current_user)]
