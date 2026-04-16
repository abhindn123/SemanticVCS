-- ============================================
-- SemanticVCS — Supabase PostgreSQL Schema
-- ============================================
-- Run this SQL in the Supabase SQL Editor:
-- https://supabase.com/dashboard → SQL Editor → New Query
-- ============================================

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    api_key TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Repositories table
CREATE TABLE IF NOT EXISTS repositories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    remote_url TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Commits table
CREATE TABLE IF NOT EXISTS commits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_id UUID REFERENCES repositories(id) ON DELETE CASCADE,
    sha TEXT NOT NULL,
    author TEXT DEFAULT '',
    message TEXT DEFAULT '',
    timestamp TIMESTAMPTZ DEFAULT now(),
    revert_status BOOLEAN DEFAULT false,
    bug_ids TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Warnings table
CREATE TABLE IF NOT EXISTS warnings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    commit_id UUID REFERENCES commits(id) ON DELETE CASCADE,
    function_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    start_line INT DEFAULT 0,
    end_line INT DEFAULT 0,
    risk_level TEXT CHECK (risk_level IN ('HIGH', 'MEDIUM', 'LOW')) DEFAULT 'LOW',
    similarity_score FLOAT DEFAULT 0.0,
    matched_commit_sha TEXT DEFAULT '',
    matched_date TIMESTAMPTZ,
    outcome TEXT DEFAULT 'unknown',
    explanation TEXT DEFAULT '',
    historical_context TEXT DEFAULT '',
    suggested_action TEXT DEFAULT '',
    dismissed BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- Indexes for performance
-- ============================================
CREATE INDEX IF NOT EXISTS idx_commits_repo_id ON commits(repo_id);
CREATE INDEX IF NOT EXISTS idx_commits_sha ON commits(sha);
CREATE INDEX IF NOT EXISTS idx_warnings_commit_id ON warnings(commit_id);
CREATE INDEX IF NOT EXISTS idx_warnings_risk_level ON warnings(risk_level);
CREATE INDEX IF NOT EXISTS idx_warnings_created_at ON warnings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_api_key ON users(api_key);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_repositories_remote_url ON repositories(remote_url);

-- ============================================
-- Row Level Security (optional, recommended)
-- ============================================
-- Uncomment these if you want RLS:
-- ALTER TABLE users ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE repositories ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE commits ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE warnings ENABLE ROW LEVEL SECURITY;
