# SemanticVCS — Codebase Memory for VS Code

> Git remembers what changed. SemanticVCS remembers why.

SemanticVCS adds a **semantic memory layer** to your Git workflow, directly inside VS Code. It silently watches every commit, understands the *meaning* of your code changes at function level, and warns you if you are about to reintroduce a bug or pattern that was previously reverted or caused issues.

No new workflow. No context switching. Just commit like you always do.

---

## How It Works

```
You commit code
      |
      v
Git Watcher detects changes
      |
      v
AST Parser (tree-sitter) extracts functions
      |
      v
UniXCoder encodes each function into a 768-dim vector
      |
      v
Qdrant searches for similar past functions
      |
      v
Neo4j checks dependency risk + blast radius
      |
      v
Gemini generates a human-readable risk explanation
      |
      v
Warning appears inline in your editor
```

If a match is found against a historically problematic commit (reverted, bug-linked, or flagged), you get an immediate, actionable warning with three options:

1. **Restore Old Approach** — Automatically restore the safe version from Git history
2. **Fix with AI (Gemini)** — Generate a context-aware fix that respects your intent while avoiding the historical mistake
3. **Continue Anyway** — Dismiss and proceed with the current code

---

## Features

### Inline Diagnostics
Functions that resemble historically risky code get flagged with diagnostic warnings directly in the editor. You will see squiggly underlines on the exact lines that triggered a match.

### Hover Explanations
Hover over any flagged function to see a quick summary: similarity score, what happened last time, and what to watch out for.

### Unified Dashboard
A rich webview dashboard that shows:
- **Warning Cards** with full context: who wrote the original code, when it was reverted, and why
- **Blast Radius** visualization: which files and functions depend on your changed code
- **Engine Status**: live stats from both the Vector DB (Qdrant) and Knowledge Graph (Neo4j)
- **Detection Pipeline**: a visual diagram of how your code flows through the analysis

### One-Click AI Fixes
Accept a Gemini-generated fix directly from the dashboard. The extension will:
- Show you a diff of what Gemini wants to change
- Let you apply the fix with one click
- Optionally stage and commit the fix automatically

### History Backfill
Train SemanticVCS on your existing repository in one command. The backfill scans up to 200 past commits, identifies reverts, embeds all functions, and builds your project's semantic memory from day one.

---

## Commands

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and search for:

| Command | Description |
|---------|-------------|
| `SemanticVCS: Analyze Current Commit` | Manually trigger risk analysis on the latest commit |
| `SemanticVCS: Open Dashboard` | Open the unified dashboard with stats, engines, and pipeline |
| `SemanticVCS: Set API Key` | Configure your backend API key for authentication |
| `SemanticVCS: Initialize Repository` | Register the current workspace with SemanticVCS |
| `SemanticVCS: Backfill Repository History` | Scan past commits and train the vector database |

---

## Extension Settings

Configure SemanticVCS through VS Code Settings (`Ctrl+,`):

| Setting | Default | Description |
|---------|---------|-------------|
| `semanticvcs.apiUrl` | `https://semanticvcs-production.up.railway.app` | Backend API URL |
| `semanticvcs.enabled` | `true` | Enable automatic analysis on each commit |
| `semanticvcs.threshold` | `0.80` | Similarity threshold for triggering warnings (0.5 to 1.0). Lower values catch more patterns but may produce false positives. |
| `semanticvcs.showInlineWarnings` | `true` | Show inline diagnostic warnings in the editor |
| `semanticvcs.showNotifications` | `true` | Show pop-up notifications for high-risk warnings |

---

## Getting Started

1. Install the extension from the `.vsix` file or VS Code Marketplace
2. Open the Command Palette and run **SemanticVCS: Set API Key**
3. Enter your API key (get one by registering with the SemanticVCS backend)
4. Open a Git repository and start committing

SemanticVCS will automatically watch for new commits and analyze them in the background. If a risk is detected, you will see inline warnings and a notification with a link to the full dashboard.

For best results, run **SemanticVCS: Backfill Repository History** after setup. This teaches the system about your project's history so it can detect risks from the very first commit onward.

---

## Supported Languages

SemanticVCS uses tree-sitter for AST parsing and supports function extraction from:

- **Python** (`.py`)
- **JavaScript** (`.js`, `.jsx`, `.mjs`, `.cjs`)
- **TypeScript** (`.ts`, `.tsx`)

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Extension Runtime | TypeScript, VS Code API |
| Bundler | esbuild |
| Code Embeddings | UniXCoder (768-dim vectors) |
| Vector Search | Qdrant Cloud |
| Knowledge Graph | Neo4j Aura |
| Risk Explanation | Google Gemini |
| Backend | FastAPI (Python 3.11) |
| Database | Supabase (PostgreSQL) |
| Cache | Upstash (Redis) |

---

## License

MIT
