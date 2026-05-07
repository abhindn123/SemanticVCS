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
import { runBackfill } from "./git/backfill";
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

  // Backfill repository history
  context.subscriptions.push(
    vscode.commands.registerCommand("semanticvcs.backfill", async () => {
      log("Backfill command triggered");
      const repoPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!repoPath) {
        vscode.window.showErrorMessage("No workspace folder open");
        return;
      }
      await runBackfill(apiClient, repoPath);
    })
  );

  // Show warnings dashboard (auto-opened after analysis)
  context.subscriptions.push(
    vscode.commands.registerCommand("semanticvcs.showWarnings", (warnings: any[], repoId: string) => {
      log(`Showing ${warnings.length} warnings in dashboard`);

      const panel = vscode.window.createWebviewPanel(
        "semanticvcs.warnings",
        "⚠️ SemanticVCS — Risk Detected",
        vscode.ViewColumn.One,
        { enableScripts: true }
      );

      panel.webview.html = getWarningsDashboardHtml(warnings, repoId);

      // Handle button clicks from the webview
      panel.webview.onDidReceiveMessage(
        async (message) => {
          if (message.command === "continue") {
            log(`User chose to CONTINUE despite warning for ${message.functionName}`);
            vscode.window.showInformationMessage(`SemanticVCS: Continuing with ${message.functionName} — be careful!`);
            panel.dispose();
          } else if (message.command === "fix") {
            log(`User chose to FIX ${message.functionName}`);
            panel.dispose();

            const repoPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
            const filePath = message.filePath;

            // Restore the previous version of the file
            const cp = require("child_process");
            try {
              cp.execSync(`git checkout HEAD~1 -- "${filePath}"`, { cwd: repoPath });
              log(`Restored ${filePath} from previous commit`);

              // Open the restored file
              const uri = vscode.Uri.file(require("path").join(repoPath, filePath));
              await vscode.window.showTextDocument(uri, {
                selection: new vscode.Range(
                  new vscode.Position(Math.max(0, message.startLine - 1), 0),
                  new vscode.Position(Math.max(0, message.endLine - 1), 999)
                ),
              });

              const action = await vscode.window.showInformationMessage(
                `✅ SemanticVCS restored ${filePath} to the safe version. Review and commit when ready.`,
                "Stage & Commit Fix",
                "Just Review"
              );

              if (action === "Stage & Commit Fix") {
                cp.execSync(`git add "${filePath}"`, { cwd: repoPath });
                cp.execSync(`git commit -m "fix: restore safe version of ${message.functionName} (SemanticVCS)"`, { cwd: repoPath });
                vscode.window.showInformationMessage("✅ Fix committed!");
                log(`Auto-committed fix for ${filePath}`);
              }
            } catch (err: any) {
              log(`Git restore failed: ${err.message}`);
              vscode.window.showErrorMessage(`Could not restore file: ${err.message}`);
              // Fallback: just open the file
              const uri = vscode.Uri.file(require("path").join(repoPath, filePath));
              vscode.window.showTextDocument(uri);
            }
          }
        },
        undefined,
        context.subscriptions
      );
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
 * Generate stats dashboard HTML.
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
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 20px; margin: 0; }
    h1 { color: var(--vscode-foreground); border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 12px; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin: 24px 0; }
    .stat-card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 20px; text-align: center; }
    .stat-value { font-size: 2.5em; font-weight: bold; margin: 8px 0; }
    .stat-label { color: var(--vscode-descriptionForeground); font-size: 0.9em; text-transform: uppercase; letter-spacing: 1px; }
    .high { color: #f44336; } .medium { color: #ff9800; } .low { color: #2196f3; } .clean { color: #4caf50; }
    .section { margin: 24px 0; }
    .section h2 { color: var(--vscode-foreground); font-size: 1.2em; margin-bottom: 12px; }
    .file-list { list-style: none; padding: 0; }
    .file-list li { padding: 8px 12px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin-bottom: 4px; font-family: var(--vscode-editor-font-family); }
    .repo-name { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  </style>
</head>
<body>
  <h1>🛡️ SemanticVCS Dashboard</h1>
  <p class="repo-name">Repository: <strong>${repoId}</strong></p>
  <div class="stats-grid">
    <div class="stat-card"><div class="stat-label">Commits Analyzed</div><div class="stat-value clean">${stats.total_commits_analyzed || 0}</div></div>
    <div class="stat-card"><div class="stat-label">Total Warnings</div><div class="stat-value">${stats.total_warnings || 0}</div></div>
    <div class="stat-card"><div class="stat-label">High Risk</div><div class="stat-value high">${high}</div></div>
    <div class="stat-card"><div class="stat-label">Medium Risk</div><div class="stat-value medium">${medium}</div></div>
    <div class="stat-card"><div class="stat-label">Low Risk</div><div class="stat-value low">${low}</div></div>
    <div class="stat-card"><div class="stat-label">Duplicate Clusters</div><div class="stat-value">${stats.duplicate_clusters || 0}</div></div>
  </div>
  ${topFiles.length > 0 ? `<div class="section"><h2>🔥 Top Risky Files</h2><ul class="file-list">${topFiles.map((f: string, i: number) => `<li>${i + 1}. ${f}</li>`).join("")}</ul></div>` : ""}
</body></html>`;
}

/**
 * Generate the rich warning dashboard with full story and action buttons.
 */
function getWarningsDashboardHtml(warnings: any[], repoId: string): string {
  const warningCards = warnings.map((w: any, i: number) => {
    const simPercent = Math.round(w.similarity_score * 100);
    const riskColor = w.risk_level === "HIGH" ? "#f44336" : w.risk_level === "MEDIUM" ? "#ff9800" : "#2196f3";
    const riskEmoji = w.risk_level === "HIGH" ? "🔴" : w.risk_level === "MEDIUM" ? "🟡" : "🔵";
    const commitShort = w.matched_commit_sha?.slice(0, 7) || "unknown";
    const authorName = w.matched_author || "a team member";
    const commitMsg = w.matched_message || "a previous change";
    const date = w.matched_date ? new Date(w.matched_date).toLocaleDateString() : "";

    return `
    <div class="warning-card" style="border-left: 4px solid ${riskColor};">
      <div class="warning-header">
        <span class="risk-badge" style="background: ${riskColor};">${riskEmoji} ${w.risk_level} RISK</span>
        <span class="similarity">${simPercent}% similar</span>
      </div>

      <div class="function-name">
        <code>${w.function_name}</code>
        <span class="file-ref">${w.file_path}:${w.start_line}-${w.end_line}</span>
      </div>

      <div class="story">
        <div class="story-section">
          <div class="story-icon">📝</div>
          <div class="story-content">
            <strong>What happened before:</strong><br>
            <span class="author">@${authorName}</span> committed
            <em>"${commitMsg}"</em>
            ${date ? `<span class="date">on ${date}</span>` : ""}
            <span class="commit-sha">(${commitShort})</span>
          </div>
        </div>

        <div class="story-section">
          <div class="story-icon">⚠️</div>
          <div class="story-content">
            <strong>What went wrong:</strong><br>
            ${w.historical_context || w.explanation}
          </div>
        </div>

        <div class="story-section">
          <div class="story-icon">🤖</div>
          <div class="story-content">
            <strong>Gemini's Analysis:</strong><br>
            ${w.explanation}
          </div>
        </div>

        ${w.suggested_action ? `
        <div class="story-section">
          <div class="story-icon">💡</div>
          <div class="story-content">
            <strong>Suggested Fix:</strong><br>
            ${w.suggested_action}
          </div>
        </div>` : ""}
      </div>

      <div class="actions">
        <button class="btn btn-fix" onclick="handleAction('fix', ${JSON.stringify({
          functionName: w.function_name,
          filePath: w.file_path,
          startLine: w.start_line,
          endLine: w.end_line,
        }).replace(/"/g, '&quot;')})">
          🔧 Fix It — Use Another Approach
        </button>
        <button class="btn btn-continue" onclick="handleAction('continue', ${JSON.stringify({
          functionName: w.function_name,
          filePath: w.file_path,
        }).replace(/"/g, '&quot;')})">
          ⚡ Continue Anyway
        </button>
      </div>
    </div>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SemanticVCS — Risk Detected</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px 30px;
      margin: 0;
      line-height: 1.6;
    }
    h1 { margin: 0 0 6px 0; font-size: 1.6em; }
    .subtitle { color: var(--vscode-descriptionForeground); font-size: 0.95em; margin-bottom: 24px; }

    .warning-card {
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 20px 24px;
      margin-bottom: 20px;
    }
    .warning-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    .risk-badge {
      color: #fff;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 0.85em;
      font-weight: bold;
      letter-spacing: 0.5px;
    }
    .similarity {
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
      font-weight: 600;
    }
    .function-name {
      margin-bottom: 16px;
    }
    .function-name code {
      font-size: 1.2em;
      font-weight: bold;
      color: var(--vscode-textLink-foreground);
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 8px;
      border-radius: 4px;
    }
    .file-ref {
      color: var(--vscode-descriptionForeground);
      font-size: 0.85em;
      margin-left: 8px;
    }

    .story { margin: 16px 0; }
    .story-section {
      display: flex;
      gap: 12px;
      padding: 12px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .story-section:last-child { border-bottom: none; }
    .story-icon { font-size: 1.3em; min-width: 28px; text-align: center; padding-top: 2px; }
    .story-content { flex: 1; font-size: 0.95em; }
    .author {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 0.9em;
      font-weight: 600;
    }
    .date { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
    .commit-sha {
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family);
      font-size: 0.85em;
    }

    .actions {
      display: flex;
      gap: 12px;
      margin-top: 20px;
      padding-top: 16px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .btn {
      flex: 1;
      padding: 10px 20px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.95em;
      font-weight: 600;
      font-family: var(--vscode-font-family);
      transition: opacity 0.2s;
    }
    .btn:hover { opacity: 0.85; }
    .btn-fix {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .btn-continue {
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-panel-border);
    }
    .btn-continue:hover {
      background: var(--vscode-editorWidget-background);
    }
  </style>
</head>
<body>
  <h1>⚠️ SemanticVCS — Risk Detected</h1>
  <p class="subtitle">
    Your commit matches ${warnings.length} historical pattern(s) that had bad outcomes in <strong>${repoId}</strong>
  </p>

  ${warningCards}

  <script>
    const vscode = acquireVsCodeApi();
    function handleAction(command, data) {
      vscode.postMessage({ command, ...data });
    }
  </script>
</body>
</html>`;
}
