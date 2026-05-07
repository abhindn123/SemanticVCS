"""
Similarity Search — Qdrant search with outcome-aware ranking.

Searches for semantically similar past functions and enriches
results with outcome metadata to calculate risk scores.
"""

import logging
from datetime import datetime

from app.models.schemas import CommitOutcome, SimilarityMatch
from app.services.qdrant_service import QdrantService
from app.services.supabase_service import SupabaseService

logger = logging.getLogger(__name__)

# Outcome weights for risk scoring
# reverted code = highest risk, clean code = lowest risk
OUTCOME_WEIGHTS = {
    CommitOutcome.REVERTED: 1.0,
    CommitOutcome.BUG_LINKED: 0.8,
    CommitOutcome.UNKNOWN: 0.3,
    CommitOutcome.CLEAN: 0.1,
}


def determine_outcome(revert_status: bool, bug_ids: list[str]) -> CommitOutcome:
    """Determine the outcome category of a historical commit."""
    if revert_status:
        return CommitOutcome.REVERTED
    if bug_ids:
        return CommitOutcome.BUG_LINKED
    return CommitOutcome.CLEAN


async def search_similar_functions(
    vector: list[float],
    repo_id: str,
    qdrant: QdrantService,
    supabase: SupabaseService,
    threshold: float = 0.80,
    limit: int = 10,
    exclude_commit_sha: str | None = None,
) -> list[SimilarityMatch]:
    """
    Search for semantically similar functions and rank by risk.

    1. Search Qdrant for vectors with cosine similarity > threshold
    2. Enrich with commit metadata from PostgreSQL
    3. Determine outcome (reverted, bug-linked, clean)
    4. Calculate risk_score = similarity × outcome_weight
    5. Sort by risk_score descending

    Args:
        vector: 768-dim query embedding
        repo_id: Repository identifier
        qdrant: Qdrant service instance
        supabase: Supabase service instance
        threshold: Minimum cosine similarity
        limit: Maximum number of results
        exclude_commit_sha: Skip matches from the same commit

    Returns:
        List of SimilarityMatch sorted by risk score (highest first)
    """
    # Step 1: Vector search
    raw_matches = await qdrant.search_similar(
        vector=vector,
        repo_id=repo_id,
        threshold=threshold,
        limit=limit * 2,  # Fetch extra to account for filtering
    )

    if not raw_matches:
        return []

    # Step 2: Enrich and score
    matches = []
    for match in raw_matches:
        commit_sha = match.get("commit_sha", "")

        # Skip self-matches
        if exclude_commit_sha and commit_sha == exclude_commit_sha:
            continue

        # Get commit info from PostgreSQL (source of truth for revert_status)
        commit_info = await supabase.get_commit_by_sha(commit_sha)
        author = match.get("author", "")
        timestamp = None

        # Determine outcome from Supabase (where seed_bad_outcome updates revert_status)
        revert_status = False
        bug_ids = []
        if commit_info:
            revert_status = commit_info.get("revert_status", False)
            bug_ids = commit_info.get("bug_ids") or []
            author = commit_info.get("author", author)
            ts = commit_info.get("timestamp")
            if ts:
                try:
                    timestamp = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                except (ValueError, TypeError):
                    pass

        outcome = determine_outcome(revert_status, bug_ids)

        # Get commit message
        commit_message = ""
        if commit_info:
            commit_message = commit_info.get("message", "")

        # Calculate risk score
        similarity = match["score"]
        outcome_weight = OUTCOME_WEIGHTS.get(outcome, 0.3)
        risk_score = similarity * outcome_weight
        logger.info(
            f"Match: {commit_sha[:7]} | sim={similarity:.4f} | "
            f"revert={revert_status} | outcome={outcome.value} | risk={risk_score:.4f}"
        )

        matches.append(SimilarityMatch(
            score=round(similarity, 4),
            commit_sha=commit_sha,
            function_name=match.get("function_name", ""),
            file_path=match.get("file_path", ""),
            code_body=match.get("code_body", ""),
            author=author,
            message=commit_message,
            timestamp=timestamp,
            revert_status=revert_status,
            bug_ids=bug_ids,
            outcome=outcome,
        ))

    # Step 3: Deduplicate by commit_sha (keep highest score per commit)
    seen_commits: dict[str, SimilarityMatch] = {}
    for m in matches:
        if m.commit_sha not in seen_commits or m.score > seen_commits[m.commit_sha].score:
            seen_commits[m.commit_sha] = m
    matches = list(seen_commits.values())

    # Step 4: Sort by risk score (similarity × outcome weight)
    matches.sort(
        key=lambda m: m.score * OUTCOME_WEIGHTS.get(m.outcome, 0.3),
        reverse=True,
    )

    # Limit results
    matches = matches[:limit]

    logger.info(
        f"Found {len(matches)} similar functions for repo {repo_id} "
        f"(threshold: {threshold})"
    )

    return matches


def is_high_risk_match(match: SimilarityMatch) -> bool:
    """Check if a match warrants a Gemini risk explanation."""
    # Only explain matches with bad outcomes
    if match.outcome == CommitOutcome.CLEAN:
        return False

    # Only explain high-similarity matches
    if match.score < 0.80:
        return False

    return True
