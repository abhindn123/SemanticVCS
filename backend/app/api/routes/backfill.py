"""
Backfill endpoint — Processes historical git commits.

POST /api/v1/backfill

Walks through a batch of historical commits from the VS Code extension,
embeds all functions, stores them in Qdrant, and auto-detects reverts
from commit messages (e.g. "Revert 'fix auth flow'").
"""

import logging
import re
import time

from fastapi import APIRouter, HTTPException, Request, status

from app.api.deps import CurrentUser, Neo4jDep, QdrantDep, RedisDep, SupabaseDep
from app.core.diff_extractor import extract_changed_functions
from app.core.embedder import CodeEmbedder
from app.core.relationship_extractor import extract_relationships
from app.models.schemas import BackfillRequest, BackfillResponse

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1", tags=["Backfill"])

# Patterns that indicate a commit is a revert
REVERT_PATTERNS = [
    re.compile(r'^Revert "(.+)"', re.IGNORECASE),              # git revert default
    re.compile(r'^Revert (.+)', re.IGNORECASE),                 # casual revert
    re.compile(r'^revert\s+([a-f0-9]{7,40})', re.IGNORECASE),  # revert <sha>
    re.compile(r'This reverts commit ([a-f0-9]{7,40})', re.IGNORECASE),  # git revert body
]


def detect_reverted_commits(
    commits: list[dict],
) -> set[str]:
    """
    Scan commit messages to find which SHAs were reverted.

    Strategy:
    1. If message matches 'Revert "<original message>"' — find the original
       commit by matching its message.
    2. If message references a SHA directly — mark that SHA.

    Returns set of SHAs that should be marked as reverted.
    """
    reverted_shas = set()
    # Build a lookup: message -> SHA
    message_to_sha = {}
    for c in commits:
        msg = c.get("message", "").strip()
        if msg:
            message_to_sha[msg] = c["sha"]

    for c in commits:
        msg = c.get("message", "").strip()
        for pattern in REVERT_PATTERNS:
            match = pattern.search(msg)
            if match:
                reverted_ref = match.group(1).strip()

                # Case 1: reverted_ref is a SHA (or prefix)
                for other in commits:
                    if other["sha"].startswith(reverted_ref) and other["sha"] != c["sha"]:
                        reverted_shas.add(other["sha"])
                        break

                # Case 2: reverted_ref is a commit message — find original
                if reverted_ref in message_to_sha:
                    original_sha = message_to_sha[reverted_ref]
                    if original_sha != c["sha"]:
                        reverted_shas.add(original_sha)

                break  # Only match first pattern

    return reverted_shas


@router.post("/backfill", response_model=BackfillResponse)
async def backfill_history(
    body: BackfillRequest,
    request: Request,
    user: CurrentUser,
    qdrant: QdrantDep,
    supabase: SupabaseDep,
    redis: RedisDep,
    neo4j: Neo4jDep,
) -> BackfillResponse:
    """
    Process historical commits in batch.

    1. Auto-detect which commits were reverts
    2. Extract functions from each commit's diffs
    3. Embed and store in Qdrant
    4. Mark reverted commits in Supabase
    """
    start_time = time.time()

    embedder: CodeEmbedder | None = request.app.state.embedder
    if embedder is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="UniXCoder model is not loaded. Server is starting up.",
        )

    # Step 1: Auto-detect reverts from commit messages
    commit_dicts = [{"sha": c.sha, "message": c.message} for c in body.commits]
    reverted_shas = detect_reverted_commits(commit_dicts)

    logger.info(
        f"Backfill: {len(body.commits)} commits, "
        f"{len(reverted_shas)} auto-detected reverts"
    )

    # Get or create repo
    repo = await supabase.get_or_create_repo(user["id"], body.repo_id)
    repo_db_id = repo["id"]

    commits_processed = 0
    functions_embedded = 0
    skipped = 0

    for commit in body.commits:
        # Store commit in Supabase
        is_reverted = commit.sha in reverted_shas
        try:
            await supabase.store_commit(
                repo_db_id=repo_db_id,
                sha=commit.sha,
                author=commit.author,
                message=commit.message,
                revert_status=is_reverted,
            )
        except Exception as e:
            # Commit might already exist (duplicate backfill)
            logger.debug(f"Commit {commit.sha[:7]} may already exist: {e}")
            # If it's a revert, update the status
            if is_reverted:
                try:
                    await supabase.mark_commit_reverted(commit.sha)
                except Exception:
                    pass

        # Process diffs
        if not commit.diffs:
            skipped += 1
            continue

        for file_diff in commit.diffs:
            try:
                changed_functions = extract_changed_functions(
                    diff=file_diff.diff,
                    file_content=file_diff.file_content,
                    file_path=file_diff.file_path,
                )
            except Exception as e:
                logger.debug(f"Failed to extract functions from {file_diff.file_path}: {e}")
                continue

            # Knowledge Graph: store relationships for this file
            if neo4j:
                try:
                    lang = file_diff.language if hasattr(file_diff, 'language') else 'typescript'
                    rels = extract_relationships(file_diff.file_content, file_diff.file_path, lang)
                    await neo4j.store_file_relationships(
                        file_path=file_diff.file_path,
                        repo_id=body.repo_id,
                        imports=rels["imports"],
                        function_names=rels["function_names"],
                        table_usages=rels["table_usages"],
                        api_calls=rels["api_calls"],
                        commit_sha=commit.sha,
                        is_reverted=is_reverted,
                    )
                except Exception as e:
                    logger.debug(f"KG storage failed for {file_diff.file_path}: {e}")

            for func_diff in changed_functions:
                # Embed the function
                code_hash = embedder.code_hash(func_diff.new_body)
                
                # Try cache first (fail-open if Redis is down)
                cached_vector = None
                try:
                    cached_vector = await redis.get_cached_embedding(body.repo_id, code_hash)
                except Exception:
                    pass  # Redis down — skip cache

                if cached_vector:
                    vector = cached_vector
                else:
                    vector_np = embedder.embed(func_diff.new_body)
                    vector = vector_np.tolist()
                    try:
                        await redis.cache_embedding(body.repo_id, code_hash, vector)
                    except Exception:
                        pass  # Redis down — skip cache

                # Store in Qdrant
                await qdrant.upsert_embedding(
                    vector=vector,
                    commit_sha=commit.sha,
                    function_name=func_diff.function_name,
                    file_path=func_diff.file_path,
                    code_body=func_diff.new_body,
                    repo_id=body.repo_id,
                    author=commit.author,
                    revert_status=is_reverted,
                )
                functions_embedded += 1

        commits_processed += 1

    # Mark all detected reverts in Supabase (idempotent)
    for sha in reverted_shas:
        try:
            await supabase.mark_commit_reverted(sha)
        except Exception as e:
            logger.debug(f"Could not mark {sha[:7]} as reverted: {e}")

    processing_time = int((time.time() - start_time) * 1000)

    logger.info(
        f"Backfill complete — processed: {commits_processed}, "
        f"embedded: {functions_embedded}, reverts: {len(reverted_shas)}, "
        f"skipped: {skipped}, time: {processing_time}ms"
    )

    return BackfillResponse(
        commits_processed=commits_processed,
        functions_embedded=functions_embedded,
        reverts_detected=len(reverted_shas),
        skipped=skipped,
        processing_time_ms=processing_time,
    )
