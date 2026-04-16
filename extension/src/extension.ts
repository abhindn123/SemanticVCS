/**
 * SemanticVCS — VS Code Extension Entry Point
 *
 * A semantic memory layer for Git. Silently analyzes every commit,
 * embeds function-level changes, and warns when code is semantically
 * similar to past commits that were reverted or caused bugs.
 *
 * @author Team JUGAADU
 * @license MIT
 */

import * as vscode from "vscode";
import { ApiClient } from "./api/client";
import { GitWatcher } from "./git/watcher";
import { DiagnosticsManager } from "./ui/diagnostics";
import { StatusBarManager } from "./ui/statusBar";
import { HoverProvider } from "./ui/hoverProvider";
import { log, logError } from "./utils/logger";

export function activate(context: vscode.ExtensionContext) {
  log("🚀 SemanticVCS extension activating...");

  // === Initialize services ===
  const apiClient = new ApiClient(context);
  const diagnostics = new DiagnosticsManager();
  const statusBar = new StatusBarManager();
  const hoverProvider = new HoverProvider();
  const gitWatcher = new GitWatcher(apiClient, diagnostics, statusBar);

  // Register hover provider
  hoverProvider.register();

  // === Register commands ===

  // Manual analysis trigger
  context.subscriptions.push(
    vscode.commands.registerCommand("semanticvcs.analyze", async () => {
      log("Manual analysis triggered");
      await gitWatcher.analyzeNow();
    })
  );

  // Open dashboard (placeholder — will show stats)
  context.subscriptions.push(
    vscode.commands.registerCommand("semanticvcs.dashboard", async () => {
      log("Dashboard requested");
      try {
        const repoPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!repoPath) {
          vscode.window.showErrorMessage("No workspace open");
          return;
        }

        const { getRepoId } = await import("./git/diffParser");
        const repoId = await getRepoId(repoPath);
        const stats = await apiClient.getStats(repoId);

        const panel = vscode.window.createWebviewPanel(
          "semanticvcs.dashboard",
          "SemanticVCS Dashboard",
          vscode.ViewColumn.One,
          { enableScripts: true }
        );

        panel.webview.html = getDashboardHtml(stats, repoId);
      } catch (error) {
        logError("Failed to open dashboard", error);
        vscode.window.showErrorMessage("Could not load dashboard. Check your connection.");
      }
    })
  );

  // Set API key
  context.subscriptions.push(
    vscode.commands.registerCommand("semanticvcs.setApiKey", async () => {
      await apiClient.promptApiKey();
    })
  );

  // Initialize repository
  context.subscriptions.push(
    vscode.commands.registerCommand("semanticvcs.init", async () => {
      await gitWatcher.initRepo();
    })
  );

  // === Add disposables ===
  context.subscriptions.push(gitWatcher, diagnostics, statusBar, hoverProvider);

  // === Start git watcher ===
  gitWatcher.start().catch((error) => {
    logError("Failed to start git watcher", error);
  });

  // Show initial status
  statusBar.show("$(shield) SemanticVCS", "Ready — watching for commits");
  log("✅ SemanticVCS extension activated");
}

export function deactivate() {
  log("SemanticVCS extension deactivated");
}

/**
 * Generate dashboard HTML with VS Code theme variables.
 */
function getDashboardHtml(stats: any, repoId: string): string {
  const high = stats.warnings_by_risk?.HIGH || 0;
  const medium = stats.warnings_by_risk?.MEDIUM || 0;
  const low = stats.warnings_by_risk?.LOW || 0;
  const topFiles = stats.top_risky_files || [];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SemanticVCS Dashboard</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px;
      margin: 0;
    }
    h1 {
      color: var(--vscode-foreground);
      border-bottom: 1px solid var(--vscode-panel-border);
      padding-bottom: 12px;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin: 24px 0;
    }
    .stat-card {
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 20px;
      text-align: center;
    }
    .stat-value {
      font-size: 2.5em;
      font-weight: bold;
      margin: 8px 0;
    }
    .stat-label {
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .high { color: #f44336; }
    .medium { color: #ff9800; }
    .low { color: #2196f3; }
    .clean { color: #4caf50; }
    .section {
      margin: 24px 0;
    }
    .section h2 {
      color: var(--vscode-foreground);
      font-size: 1.2em;
      margin-bottom: 12px;
    }
    .file-list {
      list-style: none;
      padding: 0;
    }
    .file-list li {
      padding: 8px 12px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      margin-bottom: 4px;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
    }
    .repo-name {
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
    }
  </style>
</head>
<body>
  <h1>🛡️ SemanticVCS Dashboard</h1>
  <p class="repo-name">Repository: <strong>${repoId}</strong></p>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-label">Commits Analyzed</div>
      <div class="stat-value clean">${stats.total_commits_analyzed || 0}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Total Warnings</div>
      <div class="stat-value">${stats.total_warnings || 0}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">High Risk</div>
      <div class="stat-value high">${high}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Medium Risk</div>
      <div class="stat-value medium">${medium}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Low Risk</div>
      <div class="stat-value low">${low}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Duplicate Clusters</div>
      <div class="stat-value">${stats.duplicate_clusters || 0}</div>
    </div>
  </div>

  ${topFiles.length > 0 ? `
  <div class="section">
    <h2>🔥 Top Risky Files</h2>
    <ul class="file-list">
      ${topFiles.map((f: string, i: number) => `<li>${i + 1}. ${f}</li>`).join("")}
    </ul>
  </div>` : ""}
</body>
</html>`;
}
