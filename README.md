# 🛡️ SemanticVCS
> **Git remembers what changed. We remember why.**

SemanticVCS is a **semantic memory layer** for Git. It sits quietly on top of your existing Git workflow, understands the *meaning* of your code changes, and warns you if you are about to reintroduce a bug or anti-pattern that your team previously fixed. 

Instead of relying on human memory to catch repeating mistakes, SemanticVCS analyzes every commit at the function level, maps it against your repository's entire history using vector embeddings and a knowledge graph, and flags risky patterns before they ever reach a pull request.

---

## ⚡ Key Features

* **🧠 Semantic Similarity Matching**: Uses **UniXCoder** to embed function-level changes into 768-dimensional vectors. It catches duplicate or risky logic even if variables are renamed or syntax is slightly altered.
* **🕸️ Dependency Knowledge Graph**: Uses **Neo4j** to track imports, function calls, database tables, and API endpoints. Calculates the "blast radius" of a risky change.
* **🤖 AI-Powered Fixes**: Integrates with **Google Gemini** to explain *why* a historical commit failed, and automatically generates a safe, context-aware fix.
* **🔙 Historical Backfilling**: Train the system on day one. SemanticVCS can scan your entire Git history, embed past functions, and learn from previous `Revert` commits automatically.
* **🌐 Cross-Language AST Parsing**: Built-in `tree-sitter` support for Python, JavaScript, and TypeScript to accurately extract function blocks regardless of formatting.

---

## 🛠️ The Toolchain

SemanticVCS provides two seamless ways to integrate into your workflow:

### 1. `svcs` CLI Wrapper
A drop-in replacement for the `git` CLI that adds AI-powered risk detection to your terminal.

```bash
$ svcs commit -m "update jwt validation"

✅ Committed: a1b2c3d "update jwt validation"
🚨 1 risk(s) detected!

HIGH RISK — validate_token
File: auth.py:45-60
Similarity: 92% match to reverted commit 8f9a2b1

What happened before:
Similar code was previously reverted because it lacked audience validation.

Gemini's analysis:
This change resembles a previously problematic pattern that allowed token replay attacks.

  [1] 🔄 Restore old version
  [2] 🤖 Fix with AI (Gemini)
  [3] ⚡ Continue anyway
```

**CLI Commands:**
* `svcs commit`: Runs `git commit`, analyzes the diff, and provides an interactive prompt if risks are found.
* `svcs backfill`: Scans your repository's history, embeds functions, and trains the vector database on past reverts.
* `svcs status`: Displays standard `git status` alongside SemanticVCS analytics (commits analyzed, risk breakdowns, engine status).
* *Any other command passes through natively to Git (e.g., `svcs push`, `svcs checkout`).*

### 2. VS Code Extension
A native IDE experience that catches risks as you code.

* **Inline Diagnostics**: Red squiggly lines appear under functions that resemble historically risky code.
* **Hover Explanations**: Hover over a warning to read Gemini's analysis of what went wrong in the past.
* **Unified Dashboard**: A rich webview dashboard showing detailed warning cards, Blast Radius dependency trees, and repository statistics.
* **One-Click Fixes**: Accept an AI-generated fix or automatically restore the safe version directly from the dashboard.

---

## 🏗️ Architecture & Tech Stack

SemanticVCS operates on a highly optimized, asynchronous pipeline:

1. **AST Parsing (`tree-sitter`)**: Extracts function boundaries from code diffs.
2. **Embedding (`UniXCoder`)**: Converts code intent into vector representations.
3. **Vector Search (`Qdrant`)**: Performs lightning-fast Approximate Nearest Neighbor (ANN) search against historical commits.
4. **Knowledge Graph (`Neo4j`)**: Maps dependencies to calculate the structural risk of the change.
5. **LLM Context (`Gemini`)**: Generates human-readable explanations and fixes.
6. **Persistence (`Supabase PostgreSQL`)**: Stores commit metadata, outcomes, and warning logs.
7. **Caching & Queues (`Upstash Redis` / `Celery`)**: Handles async processing and hot-caches embeddings for instant response times.

**Backend**: Python 3.11, FastAPI
**Extension**: TypeScript, VS Code API
**CLI**: Node.js

---

## 🚀 Quick Start

### 1. Deploy the Backend
The backend is Dockerized and ready to deploy on platforms like Railway.

1. Clone the repository.
2. Setup your `.env` file with credentials for Supabase, Qdrant, Upstash Redis, Neo4j, and Gemini.
3. Deploy using the provided `Dockerfile` and `railway.toml`.

### 2. Install the VS Code Extension
```bash
cd extension
npm install
npm run package
code --install-extension semanticvcs-1.0.0.vsix
```
*Open VS Code, press `Ctrl+Shift+P`, run **SemanticVCS: Set API Key**, and enter your backend URL and API Key.*

### 3. Install the CLI
```bash
cd cli
npm link
```
*You can now use `svcs` anywhere you would normally use `git`.*

### 4. Backfill Your History
To make SemanticVCS immediately useful, train it on your existing repository:
```bash
svcs backfill
```
*This will parse up to 200 past commits, embed the functions, and identify past reverts to establish a baseline of "known bad" patterns.*

---

## 📄 License
MIT License.
