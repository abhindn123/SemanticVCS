"""
Webhook endpoints — External integrations for outcome tracking.

POST /api/v1/webhook/revert   — Mark a commit as reverted (extension or manual)
POST /api/v1/webhook/ci       — CI/CD build failure notification
POST /api/v1/webhook/github   — GitHub webhook (PR closed without merge, etc.)

These endpoints allow SemanticVCS to automatically learn about bad outcomes
without manual intervention.
"""

import logging
import re

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field

from app.api.deps import QdrantDep, SupabaseDep

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/webhook", tags=["Webhooks"])


# === Request Schemas ===

class RevertRequest(BaseModel):
    """Mark a commit as reverted."""
    repo_id: str = Field(..., description="Repository identifier")
    commit_sha: str = Field(..., description="SHA of the commit that was reverted")
    reason: str = Field("", description="Optional reason for revert")


class CIFailureRequest(BaseModel):
    """CI/CD build failure notification."""
    repo_id: str = Field(..., description="Repository identifier")
    commit_sha: str = Field(..., description="SHA of the commit that caused the failure")
    pipeline: str = Field("", description="CI pipeline name (e.g. 'GitHub Actions', 'Jenkins')")
    failure_message: str = Field("", description="Build failure message/log excerpt")
    build_url: str = Field("", description="URL to the failed build")


class WebhookResponse(BaseModel):
    """Standard webhook response."""
    success: bool = True
    message: str = ""
    commits_affected: int = 0


# === Endpoints ===

@router.post("/revert", response_model=WebhookResponse)
async def webhook_revert(
    body: RevertRequest,
    supabase: SupabaseDep,
) -> WebhookResponse:
    """
    Mark a commit as reverted.

    Called by:
    - The VS Code extension when it detects a `git revert` commit
    - Manual API calls
    - CI/CD systems
    """
    count = await supabase.mark_commit_reverted(body.commit_sha)

    if count == 0:
        logger.warning(f"Revert webhook: commit {body.commit_sha[:7]} not found in database")
        return WebhookResponse(
            success=True,
            message=f"Commit {body.commit_sha[:7]} not found (may not have been analyzed yet)",
            commits_affected=0,
        )

    logger.info(
        f"Revert webhook: marked {body.commit_sha[:7]} as reverted "
        f"({count} rows, reason: {body.reason or 'none'})"
    )

    return WebhookResponse(
        success=True,
        message=f"Marked commit {body.commit_sha[:7]} as reverted",
        commits_affected=count,
    )


@router.post("/ci", response_model=WebhookResponse)
async def webhook_ci_failure(
    body: CIFailureRequest,
    supabase: SupabaseDep,
) -> WebhookResponse:
    """
    Receive CI/CD build failure notification.

    When a CI pipeline fails after a commit, this endpoint marks
    that commit as bug-linked so future similar code triggers warnings.

    Integration examples:
    - GitHub Actions: Add a step that calls this on failure
    - Jenkins: Use a post-failure webhook
    - GitLab CI: Use after_script on failure
    """
    # Mark the commit as having caused a CI failure
    commit = await supabase.get_commit_by_sha(body.commit_sha)
    if not commit:
        logger.warning(f"CI webhook: commit {body.commit_sha[:7]} not found")
        return WebhookResponse(
            success=True,
            message=f"Commit {body.commit_sha[:7]} not found",
            commits_affected=0,
        )

    # Update the commit with bug info
    try:
        bug_ids = commit.get("bug_ids") or []
        ci_ref = f"ci:{body.pipeline}:{body.commit_sha[:7]}"
        if ci_ref not in bug_ids:
            bug_ids.append(ci_ref)

        supabase.client.table("commits").update({
            "bug_ids": bug_ids,
            "revert_status": True,  # CI failure = treat as bad outcome
        }).eq("sha", body.commit_sha).execute()

        logger.info(
            f"CI webhook: marked {body.commit_sha[:7]} as failed "
            f"(pipeline: {body.pipeline})"
        )

        return WebhookResponse(
            success=True,
            message=f"Marked commit {body.commit_sha[:7]} as CI failure ({body.pipeline})",
            commits_affected=1,
        )
    except Exception as e:
        logger.error(f"CI webhook error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/github", response_model=WebhookResponse)
async def webhook_github(
    request: Request,
    supabase: SupabaseDep,
) -> WebhookResponse:
    """
    GitHub webhook endpoint for automatic outcome detection.

    Supports these events:
    - `pull_request` (closed without merge) — marks HEAD commit as rejected
    - `push` with revert detection — marks reverted commits

    Setup in GitHub:
    1. Go to repo Settings → Webhooks → Add webhook
    2. Payload URL: https://semanticvcs-production.up.railway.app/api/v1/webhook/github
    3. Content type: application/json
    4. Events: Pull requests, Pushes
    """
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    event_type = request.headers.get("X-GitHub-Event", "")
    total_affected = 0

    # === Handle Pull Request events ===
    if event_type == "pull_request":
        action = payload.get("action", "")
        pr = payload.get("pull_request", {})
        merged = pr.get("merged", False)

        # PR closed WITHOUT merge = rejected code
        if action == "closed" and not merged:
            head_sha = pr.get("head", {}).get("sha", "")
            if head_sha:
                count = await supabase.mark_commit_reverted(head_sha)
                total_affected += count
                logger.info(
                    f"GitHub webhook: PR #{pr.get('number')} closed without merge, "
                    f"marked {head_sha[:7]} as rejected ({count} rows)"
                )

    # === Handle Push events (detect revert commits) ===
    elif event_type == "push":
        commits = payload.get("commits", [])
        revert_pattern = re.compile(r'Revert "(.+)"', re.IGNORECASE)
        sha_pattern = re.compile(r'This reverts commit ([a-f0-9]{7,40})')

        # Build message->sha lookup for this push
        msg_to_sha = {c.get("message", ""): c.get("id", "") for c in commits}

        for commit in commits:
            message = commit.get("message", "")

            # Check for revert pattern in message
            revert_match = revert_pattern.search(message)
            sha_match = sha_pattern.search(message)

            if sha_match:
                # Direct SHA reference: "This reverts commit abc123..."
                reverted_sha = sha_match.group(1)
                count = await supabase.mark_commit_reverted(reverted_sha)
                total_affected += count
                logger.info(f"GitHub webhook: detected revert of {reverted_sha[:7]}")

            elif revert_match:
                # Message reference: Revert "original message"
                original_msg = revert_match.group(1)
                if original_msg in msg_to_sha:
                    original_sha = msg_to_sha[original_msg]
                    count = await supabase.mark_commit_reverted(original_sha)
                    total_affected += count
                    logger.info(f"GitHub webhook: detected revert of '{original_msg}'")

    # === Unsupported event ===
    else:
        return WebhookResponse(
            success=True,
            message=f"Event '{event_type}' is not tracked",
            commits_affected=0,
        )

    return WebhookResponse(
        success=True,
        message=f"Processed {event_type} event",
        commits_affected=total_affected,
    )
