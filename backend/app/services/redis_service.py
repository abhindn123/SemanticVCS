"""
Redis (Upstash) Service.

Handles caching of hot embeddings, rate limiting, and provides
the Celery broker connection.
"""

import json
import logging

import redis.asyncio as aioredis

from app.config import get_settings

logger = logging.getLogger(__name__)


class RedisService:
    """Async Redis client wrapper for SemanticVCS."""

    def __init__(self, client: aioredis.Redis):
        self.client = client
        self.settings = get_settings()

    # === Embedding Cache ===

    async def cache_embedding(
        self, repo_id: str, function_hash: str, vector: list[float], ttl: int = 86400
    ) -> None:
        """
        Cache an embedding vector for quick retrieval.
        TTL defaults to 24 hours.
        """
        key = f"embed:{repo_id}:{function_hash}"
        await self.client.setex(key, ttl, json.dumps(vector))

    async def get_cached_embedding(self, repo_id: str, function_hash: str) -> list[float] | None:
        """Get cached embedding if it exists."""
        key = f"embed:{repo_id}:{function_hash}"
        data = await self.client.get(key)
        if data:
            return json.loads(data)
        return None

    # === Risk Explanation Cache ===

    async def cache_explanation(
        self, match_key: str, explanation: dict, ttl: int = 3600
    ) -> None:
        """
        Cache a Gemini risk explanation to avoid duplicate API calls.
        TTL defaults to 1 hour.
        """
        key = f"explain:{match_key}"
        await self.client.setex(key, ttl, json.dumps(explanation))

    async def get_cached_explanation(self, match_key: str) -> dict | None:
        """Get cached risk explanation if it exists."""
        key = f"explain:{match_key}"
        data = await self.client.get(key)
        if data:
            return json.loads(data)
        return None

    # === Rate Limiting ===

    async def check_rate_limit(self, api_key: str) -> tuple[bool, int]:
        """
        Check if an API key has exceeded the rate limit.

        Returns (is_allowed, remaining_requests).
        """
        key = f"ratelimit:{api_key}"
        current = await self.client.get(key)

        max_requests = self.settings.RATE_LIMIT_PER_MINUTE

        if current is None:
            # First request in this window
            await self.client.setex(key, 60, 1)
            return True, max_requests - 1

        count = int(current)
        if count >= max_requests:
            return False, 0

        await self.client.incr(key)
        return True, max_requests - count - 1

    # === Health ===

    async def health_check(self) -> str:
        """Check if Redis connection is alive."""
        try:
            await self.client.ping()
            return "connected"
        except Exception as e:
            logger.error(f"Redis health check failed: {e}")
            return f"error: {str(e)}"

    async def close(self) -> None:
        """Close the Redis connection."""
        await self.client.close()
