"""
Pydantic schemas for API request/response models.

These define the exact JSON contracts between the VS Code extension and the backend.
"""

from pydantic import BaseModel, Field
from datetime import datetime
from enum import Enum


# === Enums ===

class RiskLevel(str, Enum):
    HIGH = "HIGH"
    MEDIUM = "MEDIUM"
    LOW = "LOW"


class CommitOutcome(str, Enum):
    REVERTED = "reverted"
    BUG_LINKED = "bug_linked"
    CLEAN = "clean"
    UNKNOWN = "unknown"


# === Request Schemas ===

class FileDiff(BaseModel):
    """A single file's diff data sent from the extension."""
    file_path: str = Field(..., description="Relative path to the file")
    language: str = Field(..., description="Programming language (python, javascript, typescript)")
    diff: str = Field(..., description="Unified diff string")
    file_content: str = Field(..., description="Full file content after commit")


class AnalyzeRequest(BaseModel):
    """Request body for POST /api/v1/analyze."""
    repo_id: str = Field(..., description="Repository identifier, e.g. github.com/user/repo")
    commit_sha: str = Field(..., description="Git commit SHA")
    author: str = Field("", description="Commit author email")
    message: str = Field("", description="Commit message")
    diffs: list[FileDiff] = Field(..., description="List of file diffs to analyze")


class RegisterRequest(BaseModel):
    """Request body for POST /api/v1/auth/register."""
    email: str
    password: str


class LoginRequest(BaseModel):
    """Request body for POST /api/v1/auth/login."""
    email: str
    password: str


class BackfillCommit(BaseModel):
    """A single commit from git history for backfill processing."""
    sha: str = Field(..., description="Full commit SHA")
    message: str = Field("", description="Commit message (used for revert detection)")
    author: str = Field("", description="Author email")
    diffs: list[FileDiff] = Field(default_factory=list, description="File diffs for this commit")


class BackfillRequest(BaseModel):
    """Request body for POST /api/v1/backfill."""
    repo_id: str = Field(..., description="Repository identifier")
    commits: list[BackfillCommit] = Field(..., description="Historical commits to process")


class BackfillResponse(BaseModel):
    """Response for POST /api/v1/backfill."""
    commits_processed: int = 0
    functions_embedded: int = 0
    reverts_detected: int = 0
    skipped: int = 0
    processing_time_ms: int = 0


# === Response Schemas ===

class Warning(BaseModel):
    """A single semantic risk warning."""
    id: str = Field(..., description="Warning UUID")
    function_name: str
    file_path: str
    start_line: int
    end_line: int
    risk_level: RiskLevel
    similarity_score: float = Field(..., ge=0.0, le=1.0)
    matched_commit_sha: str
    matched_date: datetime | None = None
    matched_author: str = ""
    matched_message: str = Field("", description="Original commit message")
    outcome: CommitOutcome
    explanation: str
    historical_context: str = ""
    suggested_action: str = ""


class AnalyzeResponse(BaseModel):
    """Response for POST /api/v1/analyze."""
    commit_sha: str
    analysis_id: str
    warnings: list[Warning] = []
    functions_analyzed: int = 0
    functions_stored: int = 0
    processing_time_ms: int = 0


class AuthResponse(BaseModel):
    """Response for auth endpoints."""
    user_id: str
    api_key: str
    token: str = ""


class HealthResponse(BaseModel):
    """Response for GET /health."""
    status: str = "healthy"
    qdrant: str = "unknown"
    supabase: str = "unknown"
    redis: str = "unknown"
    model_loaded: bool = False
    uptime_seconds: float = 0


class HistoryStatsResponse(BaseModel):
    """Response for GET /api/v1/history/{repo_id}/stats."""
    total_commits_analyzed: int = 0
    total_warnings: int = 0
    warnings_by_risk: dict[str, int] = {}
    top_risky_files: list[str] = []
    duplicate_clusters: int = 0


class WarningHistoryResponse(BaseModel):
    """Response for GET /api/v1/history/{repo_id}."""
    warnings: list[Warning] = []
    total: int = 0
    page: int = 1
    limit: int = 20


# === Internal Models ===

class FunctionBlock(BaseModel):
    """A single extracted function from AST parsing."""
    name: str
    body: str
    start_line: int
    end_line: int
    signature: str = ""
    file_path: str = ""


class FunctionDiff(BaseModel):
    """A function that was changed in a commit."""
    function_name: str
    old_body: str = ""
    new_body: str
    file_path: str
    start_line: int
    end_line: int
    language: str = ""


class SimilarityMatch(BaseModel):
    """A match found in the vector database."""
    score: float
    commit_sha: str
    function_name: str
    file_path: str
    code_body: str = ""
    author: str = ""
    message: str = ""
    timestamp: datetime | None = None
    revert_status: bool = False
    bug_ids: list[str] = []
    outcome: CommitOutcome = CommitOutcome.UNKNOWN


class RiskExplanation(BaseModel):
    """Structured risk explanation from Gemini."""
    risk_level: RiskLevel = RiskLevel.LOW
    explanation: str = ""
    historical_context: str = ""
    suggested_action: str = ""
