/**
 * Git Watcher — Detects new commits and triggers analysis.
 *
 * Uses VS Code's built-in Git extension API to watch for
 * HEAD changes (which indicate new commits).
 */

import * as vscode from "vscode";
import { ApiClient } from "../api/client";
import { DiagnosticsManager } from "../ui/diagnostics";
import { StatusBarManager } from "../ui/statusBar";
import { extractDiffs, getAuthor, getCommitMessage, getLatestCommitSha, getRepoId } from "./diffParser";
import { log, logError, logWarning } from "../utils/logger";

// Git extension API types
interface GitExtension {
  getAPI(version: number): GitAPI;
}

interface GitAPI {
  repositories: Repository[];
}

interface Repository {
  rootUri: vscode.Uri;
  state: RepositoryState;
}

interface RepositoryState {
  HEAD: { commit?: string } | undefined;
  onDidChange: vscode.Event<void>;
}

export class GitWatcher implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private lastHead: string | undefined;
  private isAnalyzing = false;

  constructor(
    private apiClient: ApiClient,
    private diagnostics: DiagnosticsManager,
    private statusBar: StatusBarManager
  ) {}

  /**
   * Start watching for git commits.
   */
  async start(): Promise<void> {
    log("Starting Git watcher...");

    const gitExtension = vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (!gitExtension) {
      logWarning("Git extension not found — SemanticVCS requires the built-in Git extension");
      return;
    }

    const git = gitExtension.isActive ? gitExtension.exports.getAPI(1) : undefined;
    if (!git) {
      logWarning("Git API not available");
      return;
    }

    if (git.repositories.length === 0) {
      log("No Git repositories found in workspace");
      return;
    }

    const repo = git.repositories[0];
    this.lastHead = repo.state.HEAD?.commit;

    log(`Watching repository: ${repo.rootUri.fsPath}`);
    log(`Initial HEAD: ${this.lastHead?.slice(0, 7) || "none"}`);

    // Watch for HEAD changes
    const stateWatcher = repo.state.onDidChange(async () => {
      const currentHead = repo.state.HEAD?.commit;

      if (currentHead && currentHead !== this.lastHead) {
        log(`HEAD changed: ${this.lastHead?.slice(0, 7) || "none"} → ${currentHead.slice(0, 7)}`);
        this.lastHead = currentHead;
        await this.onNewCommit(repo.rootUri.fsPath, currentHead);
      }
    });

    this.disposables.push(stateWatcher);
    log("✅ Git watcher started");
  }

  /**
   * Handle a new commit — extract diffs and send to backend.
   */
  private async onNewCommit(repoPath: string, commitSha: string): Promise<void> {
    // Check if enabled
    const config = vscode.workspace.getConfiguration("semanticvcs");
    if (!config.get<boolean>("enabled", true)) {
      log("SemanticVCS is disabled — skipping analysis");
      return;
    }

    // Check API key
    if (!(await this.apiClient.hasApiKey())) {
      logWarning("No API key set — skipping analysis");
      this.statusBar.setError("No API key — click to configure");
      return;
    }

    // Prevent concurrent analysis
    if (this.isAnalyzing) {
      log("Already analyzing — skipping");
      return;
    }

    this.isAnalyzing = true;
    this.statusBar.setAnalyzing();

    try {
      // Step 1: Extract diffs
      log("Extracting diffs...");
      const diffs = await extractDiffs(repoPath);

      if (diffs.length === 0) {
        log("No supported files changed — skipping");
        this.statusBar.setClean();
        return;
      }

      log(`Sending ${diffs.length} file(s) to backend for analysis...`);

      // Step 2: Send to backend
      const repoId = await getRepoId(repoPath);
      const author = await getAuthor(repoPath);
      const message = await getCommitMessage(repoPath);

      const result = await this.apiClient.analyze({
        repo_id: repoId,
        commit_sha: commitSha,
        author,
        message,
        diffs,
      });

      log(
        `Analysis complete — ${result.functions_analyzed} functions analyzed, ` +
        `${result.warnings.length} warnings, ${result.processing_time_ms}ms`
      );

      // Step 3: Display results
      if (result.warnings.length > 0) {
        // Set diagnostics (inline squiggles)
        this.diagnostics.setWarnings(result.warnings, repoPath);

        // Update status bar
        this.statusBar.setWarnings(result.warnings.length);

        // Show notification for HIGH risk
        const showNotifications = config.get<boolean>("showNotifications", true);
        const highRisk = result.warnings.filter((w) => w.risk_level === "HIGH");

        if (showNotifications && highRisk.length > 0) {
          const action = await vscode.window.showWarningMessage(
            `⚠️ SemanticVCS: ${highRisk.length} high-risk match(es) detected!`,
            "View Details",
            "Dismiss"
          );
          if (action === "View Details") {
            vscode.commands.executeCommand("semanticvcs.dashboard");
          }
        }
      } else {
        this.statusBar.setClean();
        this.diagnostics.clear();
      }
    } catch (error) {
      logError("Analysis failed", error);
      this.statusBar.setError("Analysis failed");

      if (error instanceof Error && error.message.includes("API key")) {
        vscode.window.showErrorMessage(
          `SemanticVCS: ${error.message}`,
          "Set API Key"
        ).then((action) => {
          if (action === "Set API Key") {
            vscode.commands.executeCommand("semanticvcs.setApiKey");
          }
        });
      }
    } finally {
      this.isAnalyzing = false;
    }
  }

  /**
   * Manually trigger analysis on the current commit.
   */
  async analyzeNow(): Promise<void> {
    const repoPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!repoPath) {
      vscode.window.showErrorMessage("No workspace folder open");
      return;
    }

    const commitSha = await getLatestCommitSha(repoPath);
    if (!commitSha) {
      vscode.window.showErrorMessage("No commits found in this repository");
      return;
    }

    await this.onNewCommit(repoPath, commitSha);
  }

  /**
   * Initialize SemanticVCS for the current repository.
   */
  async initRepo(): Promise<void> {
    if (!(await this.apiClient.hasApiKey())) {
      await this.apiClient.promptApiKey();
    }

    try {
      const health = await this.apiClient.healthCheck();
      if (health.status === "healthy") {
        vscode.window.showInformationMessage("✅ SemanticVCS is connected and ready!");
        this.statusBar.setClean();
      } else {
        vscode.window.showWarningMessage(`SemanticVCS backend status: ${health.status}`);
      }
    } catch (error) {
      logError("Health check failed", error);
      vscode.window.showErrorMessage("Could not connect to SemanticVCS backend. Check your API URL and key.");
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
