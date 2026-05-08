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

  // Open unified dashboard (stats + warnings + engines)
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

        let kgStats = null;
        try { kgStats = await apiClient.getKnowledgeGraphStats(repoId); } catch {}

        const panel = vscode.window.createWebviewPanel(
          "semanticvcs.unified",
          "🛡️ SemanticVCS",
          vscode.ViewColumn.One,
          { enableScripts: true }
        );

        panel.webview.html = getUnifiedDashboardHtml([], repoId, stats, kgStats);
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

  // Show unified dashboard with warnings (auto-opened after analysis)
  context.subscriptions.push(
    vscode.commands.registerCommand("semanticvcs.showWarnings", async (warnings: any[], repoId: string) => {
      log(`Showing ${warnings.length} warnings in unified dashboard`);

      // Fetch stats + KG + blast radius in background (fail-open)
      let stats = {}; let kgStats = null; let blastData: any = null;
      try { stats = await apiClient.getStats(repoId); } catch {}
      try { kgStats = await apiClient.getKnowledgeGraphStats(repoId); } catch {}

      // Get blast radius for the first warning's file
      if (warnings.length > 0 && warnings[0].file_path) {
        try { blastData = await apiClient.getBlastRadius(repoId, warnings[0].file_path); } catch {}
      }

      const panel = vscode.window.createWebviewPanel(
        "semanticvcs.unified",
        "🛡️ SemanticVCS — Risk Detected",
        vscode.ViewColumn.One,
        { enableScripts: true }
      );

      panel.webview.html = getUnifiedDashboardHtml(warnings, repoId, stats, kgStats, blastData);

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
          } else if (message.command === "aiFix") {
            log(`User chose AI FIX for ${message.functionName}`);

            const repoPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
            const filePath = message.filePath;
            const path = require("path");
            const fs = require("fs");
            const cp = require("child_process");

            try {
              // Read current bad code
              const fullPath = path.join(repoPath, filePath);
              const currentContent = fs.readFileSync(fullPath, "utf-8");

              // Get the safe version from git history for context
              let safeCode = "";
              try {
                safeCode = cp.execSync(`git show HEAD~1:"${filePath}"`, { cwd: repoPath, encoding: "utf-8" });
              } catch { safeCode = ""; }

              // Detect language from extension
              const ext = path.extname(filePath).slice(1);
              const langMap: Record<string, string> = { py: "python", js: "javascript", ts: "typescript", java: "java", go: "go", rs: "rust", rb: "ruby" };
              const language = langMap[ext] || ext || "python";

              let result: any = null;
              try {
                result = await vscode.window.withProgress(
                  { location: vscode.ProgressLocation.Notification, title: "🤖 Gemini is generating a smart fix...", cancellable: false },
                  async () => {
                    return await apiClient.generateFix({
                      bad_code: currentContent,
                      safe_code: safeCode,
                      explanation: message.explanation || "",
                      function_name: message.functionName || "",
                      file_path: filePath,
                      language,
                    });
                  }
                );
              } catch (apiErr: any) {
                log(`AI fix API failed: ${apiErr.message}`);
                vscode.window.showErrorMessage(`AI fix API error: ${apiErr.message}`);
                return;
              }

              log(`AI fix result: ${JSON.stringify(result).slice(0, 200)}`);

              if (result && result.fixed_code) {
                // Write to a temp file for diff view
                const tempPath = path.join(repoPath, `.semanticvcs-fix-${path.basename(filePath)}`);
                fs.writeFileSync(tempPath, result.fixed_code, "utf-8");

                // Show changes made
                const changesList = (result.changes_made || []).join(", ");
                const accept = await vscode.window.showInformationMessage(
                  `🤖 AI Fix Ready: ${result.explanation || "Gemini generated a safer version."}`,
                  "✅ Apply Fix",
                  "👁️ View Diff",
                  "❌ Discard"
                );

                if (accept === "✅ Apply Fix") {
                  fs.writeFileSync(fullPath, result.fixed_code, "utf-8");
                  try { fs.unlinkSync(tempPath); } catch {}

                  const uri = vscode.Uri.file(fullPath);
                  await vscode.window.showTextDocument(uri);

                  const commitAction = await vscode.window.showInformationMessage(
                    `✅ AI fix applied! Changes: ${changesList}`,
                    "Stage & Commit",
                    "Just Review"
                  );

                  if (commitAction === "Stage & Commit") {
                    cp.execSync(`git add "${filePath}"`, { cwd: repoPath });
                    cp.execSync(`git commit -m "fix(ai): ${message.functionName} — Gemini-generated safe version (SemanticVCS)"`, { cwd: repoPath });
                    vscode.window.showInformationMessage("✅ AI fix committed!");
                    log(`Committed Gemini fix for ${filePath}`);
                  }
                } else if (accept === "👁️ View Diff") {
                  const currentUri = vscode.Uri.file(fullPath);
                  const fixedUri = vscode.Uri.file(tempPath);
                  await vscode.commands.executeCommand("vscode.diff", currentUri, fixedUri, `${filePath} ↔ AI Fix`);
                } else {
                  try { fs.unlinkSync(tempPath); } catch {}
                }

                panel.dispose();
              } else {
                const errMsg = result?.error || "Unknown error";
                vscode.window.showErrorMessage(`AI fix failed: ${errMsg}. Try 'Restore Old Approach' instead.`);
              }
            } catch (err: any) {
              log(`AI fix failed: ${err.message}`);
              vscode.window.showErrorMessage(`AI fix failed: ${err.message}`);
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
 * Generate unified dashboard HTML — warnings + engines + pipeline in one view.
 */
function getUnifiedDashboardHtml(warnings: any[], repoId: string, stats: any = {}, kgStats: any = null, blastData: any = null): string {
  const high = (stats as any).warnings_by_risk?.HIGH || 0;
  const medium = (stats as any).warnings_by_risk?.MEDIUM || 0;
  const low = (stats as any).warnings_by_risk?.LOW || 0;
  const topFiles = (stats as any).top_risky_files || [];
  const kgActive = kgStats?.status === "active";
  const kg = kgStats?.graph_stats || {};
  const hasWarnings = warnings.length > 0;

  // Build warning cards
  const warningCards = warnings.map((w: any) => {
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
      <div class="fn-name"><code>${w.function_name}</code> <span class="file-ref">${w.file_path}:${w.start_line}-${w.end_line}</span></div>
      <div class="story">
        <div class="story-section"><div class="story-icon">📝</div><div class="story-content"><strong>What happened before:</strong><br><span class="author">@${authorName}</span> committed <em>"${commitMsg}"</em> ${date ? `<span class="date">on ${date}</span>` : ""} <span class="commit-sha">(${commitShort})</span></div></div>
        <div class="story-section"><div class="story-icon">⚠️</div><div class="story-content"><strong>What went wrong:</strong><br>${w.historical_context || w.explanation}</div></div>
        <div class="story-section"><div class="story-icon">🤖</div><div class="story-content"><strong>Gemini's Analysis:</strong><br>${w.explanation}</div></div>
        ${w.suggested_action ? `<div class="story-section"><div class="story-icon">💡</div><div class="story-content"><strong>Suggested Fix:</strong><br>${w.suggested_action}</div></div>` : ""}
      </div>
      <div class="actions">
        <button class="btn btn-restore" onclick="handleAction('fix', ${JSON.stringify({ functionName: w.function_name, filePath: w.file_path, startLine: w.start_line, endLine: w.end_line }).replace(/"/g, '&quot;')})">🔄 Restore Old Approach</button>
        <button class="btn btn-ai" onclick="handleAction('aiFix', ${JSON.stringify({ functionName: w.function_name, filePath: w.file_path, startLine: w.start_line, endLine: w.end_line, explanation: (w.explanation || '').slice(0, 300), historicalContext: (w.historical_context || '').slice(0, 300) }).replace(/"/g, '&quot;')})">🤖 Fix with AI (Gemini)</button>
        <button class="btn btn-continue" onclick="handleAction('continue', ${JSON.stringify({ functionName: w.function_name, filePath: w.file_path }).replace(/"/g, '&quot;')})">⚡ Continue As It Is</button>
      </div>
    </div>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SemanticVCS Dashboard</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 20px; margin: 0; }
    h1 { color: var(--vscode-foreground); border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 12px; }
    h2 { font-size: 1.15em; margin: 28px 0 12px 0; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 14px; margin: 20px 0; }
    .stat-card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 18px; text-align: center; }
    .stat-value { font-size: 2.2em; font-weight: bold; margin: 6px 0; }
    .stat-label { color: var(--vscode-descriptionForeground); font-size: 0.82em; text-transform: uppercase; letter-spacing: 1px; }
    .high { color: #f44336; } .medium { color: #ff9800; } .low { color: #2196f3; } .clean { color: #4caf50; }
    .subtitle { color: var(--vscode-descriptionForeground); font-size: 0.95em; margin-bottom: 20px; }
    .repo-name { color: var(--vscode-descriptionForeground); font-size: 0.9em; }

    .warning-card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 20px 24px; margin-bottom: 20px; }
    .warning-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .risk-badge { color: #fff; padding: 4px 12px; border-radius: 12px; font-size: 0.85em; font-weight: bold; }
    .similarity { color: var(--vscode-descriptionForeground); font-size: 0.9em; font-weight: 600; }
    .fn-name { margin-bottom: 16px; }
    .fn-name code { font-size: 1.2em; font-weight: bold; color: var(--vscode-textLink-foreground); background: var(--vscode-textCodeBlock-background); padding: 2px 8px; border-radius: 4px; }
    .file-ref { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-left: 8px; }
    .story { margin: 16px 0; }
    .story-section { display: flex; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--vscode-panel-border); }
    .story-section:last-child { border-bottom: none; }
    .story-icon { font-size: 1.3em; min-width: 28px; text-align: center; padding-top: 2px; }
    .story-content { flex: 1; font-size: 0.95em; }
    .author { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 1px 6px; border-radius: 3px; font-size: 0.9em; font-weight: 600; }
    .date { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
    .commit-sha { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); font-size: 0.85em; }
    .actions { display: flex; gap: 10px; margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--vscode-panel-border); }
    .btn { flex: 1; padding: 10px 16px; border: none; border-radius: 6px; cursor: pointer; font-size: 0.9em; font-weight: 600; font-family: var(--vscode-font-family); transition: all 0.2s; }
    .btn:hover { opacity: 0.85; transform: translateY(-1px); }
    .btn-restore { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn-ai { background: linear-gradient(135deg, #059669, #34d399); color: #fff; }
    .btn-ai:hover { box-shadow: 0 4px 12px rgba(5, 150, 105, 0.4); }
    .btn-continue { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); }
    .btn-continue:hover { background: var(--vscode-editorWidget-background); }

    .engines-container { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 20px 0; }
    .engine-card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 20px 22px; position: relative; overflow: hidden; }
    .engine-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px; }
    .engine-vector::before { background: linear-gradient(90deg, #7c3aed, #a78bfa); }
    .engine-graph::before { background: linear-gradient(90deg, #059669, #34d399); }
    .engine-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
    .engine-icon { font-size: 1.5em; }
    .engine-title { font-weight: 700; font-size: 1em; }
    .engine-badge { font-size: 0.7em; padding: 2px 8px; border-radius: 10px; font-weight: 600; }
    .badge-active { background: #065f46; color: #34d399; }
    .badge-inactive { background: #451a03; color: #fb923c; }
    .engine-desc { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-bottom: 14px; line-height: 1.5; }
    .engine-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .engine-stat { background: var(--vscode-editor-background); border-radius: 6px; padding: 10px; text-align: center; }
    .engine-stat-value { font-size: 1.4em; font-weight: 700; }
    .engine-stat-label { font-size: 0.72em; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.5px; }
    .vector-accent { color: #a78bfa; }
    .graph-accent { color: #34d399; }

    .flow-diagram { display: flex; align-items: center; justify-content: center; gap: 4px; flex-wrap: wrap; padding: 14px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 10px; }
    .flow-step { padding: 7px 12px; border-radius: 6px; font-size: 0.78em; font-weight: 600; }
    .flow-arrow { color: var(--vscode-descriptionForeground); font-size: 1.1em; }
    .flow-code { background: #1e1b4b; color: #c4b5fd; }
    .flow-vector { background: #2e1065; color: #a78bfa; }
    .flow-graph { background: #064e3b; color: #34d399; }
    .flow-risk { background: #7f1d1d; color: #fca5a5; }
    .flow-ai { background: #1e3a5f; color: #93c5fd; }

    .section { margin: 24px 0; }
    .file-list { list-style: none; padding: 0; }
    .file-list li { padding: 8px 12px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin-bottom: 4px; font-family: var(--vscode-editor-font-family); }
    .repo-name { color: var(--vscode-descriptionForeground); font-size: 0.9em; }

    .blast-container { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 22px 24px; margin: 20px 0; position: relative; overflow: hidden; }
    .blast-container::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px; background: linear-gradient(90deg, #ef4444, #f97316, #eab308); }
    .blast-header { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
    .blast-title { font-weight: 700; font-size: 1.1em; }
    .blast-count { background: #7f1d1d; color: #fca5a5; padding: 2px 10px; border-radius: 10px; font-size: 0.8em; font-weight: 600; }
    .blast-tree { margin: 0; padding: 0; list-style: none; }
    .blast-root { padding: 10px 14px; background: #7f1d1d33; border: 1px solid #7f1d1d; border-radius: 8px; margin-bottom: 10px; font-weight: 600; font-family: var(--vscode-editor-font-family); color: #fca5a5; font-size: 0.95em; }
    .blast-dep { display: flex; align-items: flex-start; gap: 10px; padding: 10px 14px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin-bottom: 6px; margin-left: 28px; position: relative; }
    .blast-dep::before { content: '├──→'; position: absolute; left: -28px; top: 10px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); font-size: 0.8em; }
    .blast-dep:last-child::before { content: '└──→'; }
    .blast-dep-file { font-weight: 600; font-family: var(--vscode-editor-font-family); color: var(--vscode-textLink-foreground); }
    .blast-dep-uses { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
    .blast-empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 10px 0; }
  </style>
</head>
<body>
  <h1>${hasWarnings ? '⚠️ SemanticVCS — Risk Detected' : '🛡️ SemanticVCS Dashboard'}</h1>
  ${hasWarnings ? `<p class="subtitle">Your commit matches ${warnings.length} historical pattern(s) that had bad outcomes in <strong>${repoId}</strong></p>` : `<p class="repo-name">Repository: <strong>${repoId}</strong></p>`}

  ${hasWarnings ? warningCards : ''}

  ${blastData && blastData.status === 'active' ? `
  <div class="blast-container">
    <div class="blast-header">
      <span style="font-size:1.4em">💥</span>
      <span class="blast-title">Blast Radius</span>
      <span class="blast-count">${blastData.total_affected || 0} file${(blastData.total_affected || 0) !== 1 ? 's' : ''} affected</span>
    </div>
    <div class="blast-root">📄 ${blastData.changed_file || 'unknown'} <span style="color: #fca5a5; font-weight: normal; font-size: 0.85em;">(you changed this)</span></div>
    <ul class="blast-tree">
      ${(blastData.dependent_files || []).length > 0 
        ? (blastData.dependent_files || []).map((dep: any) => `
          <li class="blast-dep">
            <div>
              <div class="blast-dep-file">📄 ${dep.file}</div>
              ${dep.uses && dep.uses.length > 0 ? `<div class="blast-dep-uses">uses: <code>${dep.uses.join('</code>, <code>')}</code></div>` : ''}
            </div>
          </li>
        `).join('')
        : '<li class="blast-empty">No dependent files found in the Knowledge Graph. Run backfill to populate.</li>'
      }
    </ul>
    ${(blastData.affected_functions || []).length > 0 ? `<div style="margin-top: 12px; color: var(--vscode-descriptionForeground); font-size: 0.85em;">⚡ Functions in changed file: <code>${blastData.affected_functions.join('</code>, <code>')}</code></div>` : ''}
  </div>` : ''}

  <div class="stats-grid">
    <div class="stat-card"><div class="stat-label">Commits Analyzed</div><div class="stat-value clean">${(stats as any).total_commits_analyzed || 0}</div></div>
    <div class="stat-card"><div class="stat-label">Total Warnings</div><div class="stat-value">${(stats as any).total_warnings || 0}</div></div>
    <div class="stat-card"><div class="stat-label">High Risk</div><div class="stat-value high">${high}</div></div>
    <div class="stat-card"><div class="stat-label">Medium Risk</div><div class="stat-value medium">${medium}</div></div>
    <div class="stat-card"><div class="stat-label">Low Risk</div><div class="stat-value low">${low}</div></div>
  </div>

  <h2>⚙️ Analysis Engines</h2>
  <div class="engines-container">
    <div class="engine-card engine-vector">
      <div class="engine-header">
        <span class="engine-icon">🔮</span>
        <span class="engine-title">Vector DB — Qdrant</span>
        <span class="engine-badge badge-active">ACTIVE</span>
      </div>
      <div class="engine-desc">
        UniXCoder embeds each function into a 768-dim vector.
        Detects code that <strong>semantically matches</strong> reverted patterns — even with renamed variables.
      </div>
      <div class="engine-stats">
        <div class="engine-stat"><div class="engine-stat-value vector-accent">${(stats as any).total_commits_analyzed || 0}</div><div class="engine-stat-label">Commits Indexed</div></div>
        <div class="engine-stat"><div class="engine-stat-value vector-accent">${(stats as any).total_warnings || 0}</div><div class="engine-stat-label">Risks Detected</div></div>
      </div>
    </div>
    <div class="engine-card engine-graph">
      <div class="engine-header">
        <span class="engine-icon">🕸️</span>
        <span class="engine-title">Knowledge Graph — Neo4j</span>
        <span class="engine-badge ${kgActive ? 'badge-active' : 'badge-inactive'}">${kgActive ? 'ACTIVE' : 'CONNECTING'}</span>
      </div>
      <div class="engine-desc">
        Tracks <strong>dependency relationships</strong> — imports, function calls, DB tables, APIs.
        Detects risk from shared dependencies with reverted code.
      </div>
      <div class="engine-stats">
        <div class="engine-stat"><div class="engine-stat-value graph-accent">${kg.files || 0}</div><div class="engine-stat-label">Files Tracked</div></div>
        <div class="engine-stat"><div class="engine-stat-value graph-accent">${kg.functions || 0}</div><div class="engine-stat-label">Functions</div></div>
        <div class="engine-stat"><div class="engine-stat-value graph-accent">${kg.tables || 0}</div><div class="engine-stat-label">DB Tables</div></div>
        <div class="engine-stat"><div class="engine-stat-value graph-accent">${kg.commits || 0}</div><div class="engine-stat-label">Commits</div></div>
      </div>
    </div>
  </div>

  <h2>🔄 Detection Pipeline</h2>
  <div class="flow-diagram">
    <div class="flow-step flow-code">📝 Code Change</div>
    <span class="flow-arrow">→</span>
    <div class="flow-step flow-code">🌳 tree-sitter AST</div>
    <span class="flow-arrow">→</span>
    <div class="flow-step flow-vector">🔮 UniXCoder Embed</div>
    <span class="flow-arrow">→</span>
    <div class="flow-step flow-vector">🔍 Qdrant Search</div>
    <span class="flow-arrow">→</span>
    <div class="flow-step flow-graph">🕸️ Neo4j Deps</div>
    <span class="flow-arrow">→</span>
    <div class="flow-step flow-risk">⚠️ Combined Risk</div>
    <span class="flow-arrow">→</span>
    <div class="flow-step flow-ai">🤖 Gemini Explains</div>
  </div>

  ${topFiles.length > 0 ? `<div class="section"><h2>🔥 Top Risky Files</h2><ul class="file-list">${topFiles.map((f: string, i: number) => `<li>${i + 1}. ${f}</li>`).join("")}</ul></div>` : ""}

  <script>
    const vscode = acquireVsCodeApi();
    function handleAction(command, data) {
      vscode.postMessage({ command, ...data });
    }
  </script>
</body></html>`;
}

