/**
 * API Response Types — TypeScript interfaces matching the backend Pydantic schemas.
 */

export type RiskLevel = "HIGH" | "MEDIUM" | "LOW";

export type CommitOutcome = "reverted" | "bug_linked" | "clean" | "unknown";

export interface FileDiff {
  file_path: string;
  language: string;
  diff: string;
  file_content: string;
}

export interface AnalyzeRequest {
  repo_id: string;
  commit_sha: string;
  author: string;
  message: string;
  diffs: FileDiff[];
}

export interface Warning {
  id: string;
  function_name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  risk_level: RiskLevel;
  similarity_score: number;
  matched_commit_sha: string;
  matched_date: string | null;
  matched_author: string;
  matched_message: string;
  outcome: CommitOutcome;
  explanation: string;
  historical_context: string;
  suggested_action: string;
}

export interface AnalyzeResponse {
  commit_sha: string;
  analysis_id: string;
  warnings: Warning[];
  functions_analyzed: number;
  functions_stored: number;
  processing_time_ms: number;
}

export interface HealthResponse {
  status: string;
  qdrant: string;
  supabase: string;
  redis: string;
  model_loaded: boolean;
  uptime_seconds: number;
}

export interface AuthResponse {
  user_id: string;
  api_key: string;
  token: string;
}

export interface HistoryStats {
  total_commits_analyzed: number;
  total_warnings: number;
  warnings_by_risk: Record<string, number>;
  top_risky_files: string[];
  duplicate_clusters: number;
}

export interface BackfillCommit {
  sha: string;
  message: string;
  author: string;
  diffs: FileDiff[];
}

export interface BackfillRequest {
  repo_id: string;
  commits: BackfillCommit[];
}

export interface BackfillResponse {
  commits_processed: number;
  functions_embedded: number;
  reverts_detected: number;
  skipped: number;
  processing_time_ms: number;
}
