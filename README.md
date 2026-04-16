# SemanticVCS — Codebase Memory for Git

> A semantic version control layer that remembers every code decision your team has ever made — and warns you before you repeat a mistake.

## What It Does

When you `git commit`, SemanticVCS silently:

1. **Extracts functions** from your changed files (AST parsing)
2. **Embeds them** into 768-dimensional vectors (UniXCoder)
3. **Searches** your entire commit history for similar code (Qdrant)
4. **Checks outcomes** — was that similar code reverted? Bug-linked?
5. **Warns you** inline in VS Code if you're about to repeat a mistake

## Architecture

```
Developer commits
       ↓
   Git Watcher → Backend API (FastAPI on Railway)
                     ↓
                 AST Parser (tree-sitter) → UniXCoder (ONNX)
                     ↓
                 Qdrant Cloud (vector search)
                     ↓
                 Gemini API (risk explanation)
                     ↓
              ⚠️ Inline warnings in VS Code
```

## Quick Start

### 1. Install the VS Code Extension

Search **"SemanticVCS"** in the VS Code Marketplace, or:

```bash
code --install-extension jugaadu.semanticvcs
```

### 2. Get an API Key

1. Register at the SemanticVCS dashboard
2. Copy your API key (`svcs_xxxxxxxxxxxxx`)
3. In VS Code: `Ctrl+Shift+P` → **SemanticVCS: Set API Key**

### 3. Commit Code

That's it. SemanticVCS watches for commits automatically.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| **Backend** | Python 3.11+ / FastAPI |
| **Vector DB** | Qdrant Cloud |
| **Database** | Supabase (PostgreSQL) |
| **Cache** | Upstash (Redis) |
| **ML Model** | UniXCoder (ONNX Runtime) |
| **LLM** | Gemini API |
| **Extension** | TypeScript / VS Code API |
| **Deployment** | Railway.app / Docker |

## Team JUGAADU

Built for **HACK-O-LUTION 2K26**

| Member | Role |
|--------|------|
| Kripasindhu Ghosh | Lead — Backend & Architecture |
| Piuli Biswas | VS Code Extension & UI |
| Amrit Kar | ML Pipeline & Embeddings |
| Abhinandan Ghosh | Infrastructure & Testing |

## License

MIT
