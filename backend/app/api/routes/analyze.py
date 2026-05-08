"""
Analyze endpoint — The heart of SemanticVCS.

POST /api/v1/analyze

Receives commit diffs from the VS Code extension, extracts functions,
embeds them, searches for similar past commits, and returns warnings.
"""

import logging
import time
from uuid import uuid4

from fastapi import APIRouter, Body, HTTPException, Request, status

from app.api.deps import CurrentUser, Neo4jDep, QdrantDep, RedisDep, SupabaseDep
from app.config import get_settings
from app.core.diff_extractor import extract_changed_functions
from app.core.embedder import CodeEmbedder
from app.core.relationship_extractor import extract_relationships
from app.core.risk_analyzer import RiskAnalyzer
from app.core.similarity import is_high_risk_match, search_similar_functions
from app.models.schemas import (
    AnalyzeRequest,
    AnalyzeResponse,
    RiskLevel,
    Warning,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1", tags=["Analysis"])


@router.post("/analyze", response_model=AnalyzeResponse)
async def analyze_commit(
    body: AnalyzeRequest,
    request: Request,
    user: CurrentUser,
    qdrant: QdrantDep,
    supabase: SupabaseDep,
    redis: RedisDep,
    neo4j: Neo4jDep,
) -> AnalyzeResponse:
    """
    Analyze a commit for semantic similarity to past problematic code.

    Pipeline:
    1. For each file diff → extract changed functions (AST)
    2. Embed each function → 768-dim vector (UniXCoder)
    3. Search Qdrant for similar past functions
    4. Check outcome of matches (reverted? bug-linked?)
    5. For risky matches → generate explanation (Gemini)
    6. Store new embeddings in Qdrant
    7. Store commit + warnings in PostgreSQL
    8. Return warnings to the extension
    """
    start_time = time.time()
    settings = get_settings()

    # Verify model is loaded
    embedder: CodeEmbedder | None = request.app.state.embedder
    if embedder is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="UniXCoder model is not loaded. The server is still starting up.",
        )

    # Get or create repo in database
    repo = await supabase.get_or_create_repo(user["id"], body.repo_id)
    repo_db_id = repo["id"]

    # Store the commit
    commit = await supabase.store_commit(
        repo_db_id=repo_db_id,
        sha=body.commit_sha,
        author=body.author,
        message=body.message,
    )

    # Initialize Gemini risk analyzer
    risk_analyzer = RiskAnalyzer(
        api_key=settings.GEMINI_API_KEY,
        model_name=settings.GEMINI_MODEL,
    )

    all_warnings: list[Warning] = []
    functions_analyzed = 0
    functions_stored = 0

    for file_diff in body.diffs:
        logger.info(f"Processing {file_diff.file_path}...")

        # Step 1: Extract changed functions
        changed_functions = extract_changed_functions(
            diff=file_diff.diff,
            file_content=file_diff.file_content,
            file_path=file_diff.file_path,
        )

        if not changed_functions:
            logger.debug(f"No functions found in {file_diff.file_path}")
            continue

        # Knowledge Graph: extract and store relationships
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
                    commit_sha=body.commit_sha,
                )
            except Exception as e:
                logger.warning(f"KG storage failed for {file_diff.file_path}: {e}")

        for func_diff in changed_functions:
            functions_analyzed += 1

            # Step 2: Check embedding cache (fail-open if Redis is down)
            code_hash = embedder.code_hash(func_diff.new_body)
            cached_vector = None
            try:
                cached_vector = await redis.get_cached_embedding(body.repo_id, code_hash)
            except Exception:
                pass

            if cached_vector:
                vector = cached_vector
            else:
                # Embed the function
                vector_np = embedder.embed(func_diff.new_body)
                vector = vector_np.tolist()

                # Cache the embedding (best-effort)
                try:
                    await redis.cache_embedding(body.repo_id, code_hash, vector)
                except Exception:
                    pass

            # Step 3: Search for similar past functions (VECTOR)
            matches = await search_similar_functions(
                vector=vector,
                repo_id=body.repo_id,
                qdrant=qdrant,
                supabase=supabase,
                threshold=settings.SIMILARITY_THRESHOLD,
                exclude_commit_sha=body.commit_sha,
            )

            # Step 3b: Check Knowledge Graph for dependency risk
            graph_risk = None
            if neo4j:
                try:
                    graph_risk = await neo4j.get_dependency_risk(
                        file_path=file_diff.file_path,
                        repo_id=body.repo_id,
                    )
                    if graph_risk["graph_risk_score"] > 0:
                        logger.info(
                            f"KG risk for {file_diff.file_path}: "
                            f"score={graph_risk['graph_risk_score']:.2f}, "
                            f"tables={graph_risk['shared_reverted_tables']}, "
                            f"blast_radius={graph_risk['blast_radius']}"
                        )
                except Exception as e:
                    logger.warning(f"KG risk check failed: {e}")

            # Step 4: Process matches
            for match in matches:
                if not is_high_risk_match(match):
                    continue

                # Check for cached explanation
                explain_key = f"{code_hash}:{match.commit_sha}"
                cached_explain = await redis.get_cached_explanation(explain_key)

                if cached_explain:
                    risk_explanation = cached_explain
                else:
                    # Step 5: Call Gemini for risk explanation
                    explanation = await risk_analyzer.analyze_risk(
                        current_code=func_diff.new_body,
                        historical_code=match.code_body,
                        outcome=match.outcome.value,
                        similarity_score=match.score,
                        function_name=func_diff.function_name,
                        file_path=func_diff.file_path,
                    )
                    risk_explanation = {
                        "risk_level": explanation.risk_level.value,
                        "explanation": explanation.explanation,
                        "historical_context": explanation.historical_context,
                        "suggested_action": explanation.suggested_action,
                    }

                    # Cache the explanation
                    await redis.cache_explanation(explain_key, risk_explanation)

                # Create warning
                warning_id = str(uuid4())
                warning = Warning(
                    id=warning_id,
                    function_name=func_diff.function_name,
                    file_path=func_diff.file_path,
                    start_line=func_diff.start_line,
                    end_line=func_diff.end_line,
                    risk_level=RiskLevel(risk_explanation["risk_level"]),
                    similarity_score=round(match.score, 4),
                    matched_commit_sha=match.commit_sha,
                    matched_date=match.timestamp,
                    matched_author=match.author,
                    matched_message=match.message,
                    outcome=match.outcome,
                    explanation=risk_explanation["explanation"],
                    historical_context=risk_explanation.get("historical_context", ""),
                    suggested_action=risk_explanation.get("suggested_action", ""),
                )
                all_warnings.append(warning)

                # Store warning in database
                await supabase.store_warning(
                    commit_id=commit["id"],
                    function_name=warning.function_name,
                    file_path=warning.file_path,
                    start_line=warning.start_line,
                    end_line=warning.end_line,
                    risk_level=warning.risk_level.value,
                    similarity_score=warning.similarity_score,
                    matched_commit_sha=warning.matched_commit_sha,
                    matched_date=warning.matched_date.isoformat() if warning.matched_date else None,
                    outcome=warning.outcome.value,
                    explanation=warning.explanation,
                    historical_context=warning.historical_context,
                    suggested_action=warning.suggested_action,
                )

            # Step 6: Store the new embedding in Qdrant (always, even if no match)
            await qdrant.upsert_embedding(
                vector=vector,
                commit_sha=body.commit_sha,
                function_name=func_diff.function_name,
                file_path=func_diff.file_path,
                code_body=func_diff.new_body,
                repo_id=body.repo_id,
                author=body.author,
            )
            functions_stored += 1

    processing_time = int((time.time() - start_time) * 1000)

    logger.info(
        f"Analysis complete — "
        f"analyzed: {functions_analyzed}, stored: {functions_stored}, "
        f"warnings: {len(all_warnings)}, time: {processing_time}ms"
    )

    return AnalyzeResponse(
        commit_sha=body.commit_sha,
        analysis_id=str(uuid4()),
        warnings=all_warnings,
        functions_analyzed=functions_analyzed,
        functions_stored=functions_stored,
        processing_time_ms=processing_time,
    )


@router.post("/generate-fix", tags=["Analysis"])
async def generate_fix(
    request: Request,
    body: dict = Body(...),
    user: CurrentUser = None,
):
    """
    Generate a smart AI fix for risky code using Gemini.

    Instead of dumb git restore, Gemini writes a NEW version that
    fixes the vulnerability while respecting the developer's intent.
    """
    settings = get_settings()

    if not settings.GEMINI_API_KEY:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Gemini API key not configured",
        )

    risk_analyzer = RiskAnalyzer(
        api_key=settings.GEMINI_API_KEY,
        model_name=settings.GEMINI_MODEL,
    )

    result = await risk_analyzer.generate_fix(
        bad_code=body.get("bad_code", ""),
        safe_code=body.get("safe_code", ""),
        explanation=body.get("explanation", ""),
        function_name=body.get("function_name", ""),
        file_path=body.get("file_path", ""),
        language=body.get("language", "python"),
    )

    return result
