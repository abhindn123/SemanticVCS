"""
Warning history endpoints.

Provides paginated warning history and aggregate statistics
for a repository.
"""

import logging

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from app.api.deps import CurrentUser, SupabaseDep
from app.models.schemas import HistoryStatsResponse, WarningHistoryResponse

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/history", tags=["History"])


@router.get("/{repo_id:path}", response_model=WarningHistoryResponse)
async def get_warning_history(
    repo_id: str,
    user: CurrentUser,
    supabase: SupabaseDep,
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
) -> WarningHistoryResponse:
    """
    Get paginated warning history for a repository.

    Returns recent warnings sorted by creation date (newest first).
    """
    warnings, total = await supabase.get_warnings_for_repo(
        repo_id=repo_id, page=page, limit=limit
    )

    return WarningHistoryResponse(
        warnings=warnings,
        total=total,
        page=page,
        limit=limit,
    )


@router.get("/{repo_id:path}/stats", response_model=HistoryStatsResponse)
async def get_warning_stats(
    repo_id: str,
    user: CurrentUser,
    supabase: SupabaseDep,
) -> HistoryStatsResponse:
    """
    Get aggregate warning statistics for a repository.

    Returns total commits, warning counts by risk level,
    top risky files, and duplicate cluster count.
    """
    try:
        # First get the repo DB id
        repo = await supabase.get_or_create_repo(user["id"], repo_id)
        stats = await supabase.get_warning_stats(repo["id"])

        return HistoryStatsResponse(**stats)
    except Exception as e:
        import traceback
        return JSONResponse(status_code=500, content={"error": str(e), "trace": traceback.format_exc()})
