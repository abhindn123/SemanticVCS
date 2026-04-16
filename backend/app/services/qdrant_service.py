"""
Qdrant Vector Database Service.

Manages the async Qdrant client connection, collection creation,
embedding storage, and similarity search operations.
"""

import logging
from datetime import datetime
from uuid import uuid4

from qdrant_client import AsyncQdrantClient
from qdrant_client.models import (
    Distance,
    FieldCondition,
    Filter,
    MatchValue,
    PointStruct,
    VectorParams,
)

from app.config import get_settings

logger = logging.getLogger(__name__)


class QdrantService:
    """Async Qdrant client wrapper for SemanticVCS."""

    def __init__(self, client: AsyncQdrantClient):
        self.client = client
        self.settings = get_settings()
        self.collection_name = self.settings.QDRANT_COLLECTION

    async def ensure_collection(self) -> None:
        """Create the code_embeddings collection if it doesn't exist."""
        collections = await self.client.get_collections()
        existing = [c.name for c in collections.collections]

        if self.collection_name not in existing:
            await self.client.create_collection(
                collection_name=self.collection_name,
                vectors_config=VectorParams(
                    size=self.settings.QDRANT_VECTOR_SIZE,  # 768 for UniXCoder
                    distance=Distance.COSINE,
                ),
            )
            # IMPORTANT: Create index for repo_id because Qdrant Cloud requires payload indexing for filtering
            await self.client.create_payload_index(
                collection_name=self.collection_name,
                field_name="repo_id",
                field_schema="keyword",
            )
            logger.info(f"Created Qdrant collection: {self.collection_name}")
        else:
            logger.info(f"Qdrant collection already exists: {self.collection_name}")

    async def upsert_embedding(
        self,
        vector: list[float],
        commit_sha: str,
        function_name: str,
        file_path: str,
        code_body: str,
        repo_id: str,
        author: str = "",
        revert_status: bool = False,
        bug_ids: list[str] | None = None,
    ) -> str:
        """
        Store a function embedding in Qdrant with rich metadata.

        Returns the point ID.
        """
        point_id = str(uuid4())

        await self.client.upsert(
            collection_name=self.collection_name,
            points=[
                PointStruct(
                    id=point_id,
                    vector=vector,
                    payload={
                        "commit_sha": commit_sha,
                        "function_name": function_name,
                        "file_path": file_path,
                        "code_body": code_body,
                        "repo_id": repo_id,
                        "author": author,
                        "revert_status": revert_status,
                        "bug_ids": bug_ids or [],
                        "timestamp": datetime.utcnow().isoformat(),
                    },
                )
            ],
        )

        logger.debug(f"Stored embedding for {function_name} in {file_path} (commit: {commit_sha[:7]})")
        return point_id

    async def search_similar(
        self,
        vector: list[float],
        repo_id: str,
        threshold: float | None = None,
        limit: int | None = None,
    ) -> list[dict]:
        """
        Search for semantically similar functions in the vector database.

        Args:
            vector: 768-dim query vector
            repo_id: Filter by repository
            threshold: Minimum cosine similarity (default from settings)
            limit: Max results (default from settings)

        Returns:
            List of matches with score and payload
        """
        if threshold is None:
            threshold = self.settings.SIMILARITY_THRESHOLD
        if limit is None:
            limit = self.settings.MAX_SEARCH_RESULTS

        results = await self.client.search(
            collection_name=self.collection_name,
            query_vector=vector,
            query_filter=Filter(
                must=[
                    FieldCondition(
                        key="repo_id",
                        match=MatchValue(value=repo_id),
                    )
                ]
            ),
            score_threshold=threshold,
            limit=limit,
            with_payload=True,
        )

        matches = []
        for result in results:
            matches.append({
                "score": result.score,
                "id": result.id,
                **result.payload,
            })

        logger.debug(f"Found {len(matches)} similar functions for repo {repo_id}")
        return matches

    async def get_collection_info(self) -> dict:
        """Get collection stats for health check."""
        try:
            info = await self.client.get_collection(self.collection_name)
            return {
                "status": "connected",
                "vectors_count": info.vectors_count,
                "points_count": info.points_count,
            }
        except Exception as e:
            logger.error(f"Qdrant health check failed: {e}")
            return {"status": "error", "error": str(e)}

    async def delete_repo_vectors(self, repo_id: str) -> None:
        """Delete all vectors for a specific repository."""
        await self.client.delete(
            collection_name=self.collection_name,
            points_selector=Filter(
                must=[
                    FieldCondition(
                        key="repo_id",
                        match=MatchValue(value=repo_id),
                    )
                ]
            ),
        )
        logger.info(f"Deleted all vectors for repo: {repo_id}")
