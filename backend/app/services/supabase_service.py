"""
Supabase (PostgreSQL) Service.

Handles all relational data: users, repositories, commits, and warnings.
Uses the Supabase Python client for managed PostgreSQL.
"""

import logging
import secrets
from datetime import datetime
from uuid import uuid4

import bcrypt
from supabase import create_client, Client

from app.config import get_settings

logger = logging.getLogger(__name__)


class SupabaseService:
    """Supabase client wrapper for SemanticVCS."""

    def __init__(self, client: Client):
        self.client = client
        self.settings = get_settings()

    # === Users ===

    async def create_user(self, email: str, password: str) -> dict:
        """Register a new user and generate API key."""
        user_id = str(uuid4())
        api_key = f"{self.settings.API_KEY_PREFIX}{secrets.token_urlsafe(32)}"
        password_hash = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

        result = self.client.table("users").insert({
            "id": user_id,
            "email": email,
            "password_hash": password_hash,
            "api_key": api_key,
        }).execute()

        logger.info(f"Created user: {email}")
        return {"user_id": user_id, "api_key": api_key}

    async def authenticate_user(self, email: str, password: str) -> dict | None:
        """Verify email + password, return user data if valid."""
        result = self.client.table("users").select("*").eq("email", email).execute()

        if not result.data:
            return None

        user = result.data[0]
        if not bcrypt.checkpw(password.encode('utf-8'), user["password_hash"].encode('utf-8')):
            return None

        return {"user_id": user["id"], "api_key": user["api_key"], "email": user["email"]}

    async def get_user_by_api_key(self, api_key: str) -> dict | None:
        """Look up user by API key (used for request auth)."""
        result = self.client.table("users").select("*").eq("api_key", api_key).execute()
        return result.data[0] if result.data else None

    # === Repositories ===

    async def get_or_create_repo(self, user_id: str, repo_id: str) -> dict:
        """Get existing repo or create a new one."""
        result = self.client.table("repositories").select("*").eq(
            "remote_url", repo_id
        ).execute()

        if result.data:
            return result.data[0]

        repo = {
            "id": str(uuid4()),
            "user_id": user_id,
            "name": repo_id.split("/")[-1] if "/" in repo_id else repo_id,
            "remote_url": repo_id,
        }
        self.client.table("repositories").insert(repo).execute()
        logger.info(f"Created repo: {repo_id}")
        return repo

    # === Commits ===

    async def store_commit(
        self,
        repo_db_id: str,
        sha: str,
        author: str = "",
        message: str = "",
        revert_status: bool = False,
        bug_ids: list[str] | None = None,
    ) -> dict:
        """Store a commit record."""
        commit = {
            "id": str(uuid4()),
            "repo_id": repo_db_id,
            "sha": sha,
            "author": author,
            "message": message,
            "timestamp": datetime.utcnow().isoformat(),
            "revert_status": revert_status,
            "bug_ids": bug_ids or [],
        }
        self.client.table("commits").insert(commit).execute()
        return commit

    async def check_revert_status(self, commit_sha: str) -> bool:
        """Check if a commit was reverted."""
        result = self.client.table("commits").select("revert_status").eq(
            "sha", commit_sha
        ).execute()
        if result.data:
            return result.data[0].get("revert_status", False)
        return False

    async def get_commit_by_sha(self, sha: str) -> dict | None:
        """Get commit details by SHA."""
        result = self.client.table("commits").select("*").eq("sha", sha).execute()
        return result.data[0] if result.data else None

    async def mark_commit_reverted(self, sha: str) -> int:
        """Mark all commits with this SHA as reverted. Returns count updated."""
        result = self.client.table("commits").update(
            {"revert_status": True}
        ).eq("sha", sha).execute()
        count = len(result.data) if result.data else 0
        if count > 0:
            logger.info(f"Marked commit {sha[:7]} as REVERTED ({count} rows)")
        return count

    # === Warnings ===

    async def store_warning(
        self,
        commit_id: str,
        function_name: str,
        file_path: str,
        start_line: int,
        end_line: int,
        risk_level: str,
        similarity_score: float,
        matched_commit_sha: str,
        matched_date: str | None = None,
        outcome: str = "unknown",
        explanation: str = "",
        historical_context: str = "",
        suggested_action: str = "",
    ) -> dict:
        """Store a generated warning."""
        warning = {
            "id": str(uuid4()),
            "commit_id": commit_id,
            "function_name": function_name,
            "file_path": file_path,
            "start_line": start_line,
            "end_line": end_line,
            "risk_level": risk_level,
            "similarity_score": similarity_score,
            "matched_commit_sha": matched_commit_sha,
            "matched_date": matched_date,
            "outcome": outcome,
            "explanation": explanation,
            "historical_context": historical_context,
            "suggested_action": suggested_action,
            "dismissed": False,
        }
        self.client.table("warnings").insert(warning).execute()
        logger.info(f"Stored {risk_level} warning for {function_name} in {file_path}")
        return warning

    async def get_warnings_for_repo(
        self, repo_id: str, page: int = 1, limit: int = 20
    ) -> tuple[list[dict], int]:
        """Get paginated warnings for a repository."""
        offset = (page - 1) * limit

        # Get warnings via join through commits
        result = self.client.table("warnings").select(
            "*, commits!inner(repo_id, sha)"
        ).eq(
            "commits.repo_id", repo_id
        ).order(
            "created_at", desc=True
        ).range(offset, offset + limit - 1).execute()

        # Get total count
        count_result = self.client.table("warnings").select(
            "id", count="exact"
        ).eq(
            "commits.repo_id", repo_id
        ).execute()

        total = count_result.count if count_result.count else 0
        return result.data or [], total

    async def get_warning_stats(self, repo_db_id: str) -> dict:
        """Get aggregate warning statistics for a repository."""
        # Count commits
        commits = self.client.table("commits").select(
            "id", count="exact"
        ).eq("repo_id", repo_db_id).execute()

        # Count warnings by risk level for this repo
        warnings = self.client.table("warnings").select(
            "risk_level, file_path, commits!inner(repo_id)"
        ).eq("commits.repo_id", repo_db_id).execute()

        by_risk = {"HIGH": 0, "MEDIUM": 0, "LOW": 0}
        file_counts: dict[str, int] = {}

        for w in warnings.data or []:
            level = w.get("risk_level", "LOW")
            if level in by_risk:
                by_risk[level] += 1
            fp = w.get("file_path", "")
            file_counts[fp] = file_counts.get(fp, 0) + 1

        top_files = sorted(file_counts, key=file_counts.get, reverse=True)[:5]

        return {
            "total_commits_analyzed": commits.count or 0,
            "total_warnings": sum(by_risk.values()),
            "warnings_by_risk": by_risk,
            "top_risky_files": top_files,
            "duplicate_clusters": 0,  # TODO: implement in scan_task
        }

    # === Health ===

    async def health_check(self) -> str:
        """Check if Supabase connection is alive."""
        try:
            self.client.table("users").select("id").limit(1).execute()
            return "connected"
        except Exception as e:
            logger.error(f"Supabase health check failed: {e}")
            return f"error: {str(e)}"
