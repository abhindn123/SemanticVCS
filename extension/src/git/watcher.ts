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

    // Wait for git extension to activate if needed
    if (!gitExtension.isActive) {
      await gitExtension.activate();
    }

    const git = gitExtension.exports.getAPI(1);
    if (!git) {
      logWarning("Git API not available");
      return;
    }

    // Retry finding repos — VS Code Git extension discovers them async
    let repo: GitRepository | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      if (git.repositories.length > 0) {
        repo = git.repositories[0] as unknown as GitRepository;
        break;
      }
      log(`Waiting for Git repository to be discovered... (attempt ${attempt + 1}/10)`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    // If still not found, listen for when one gets added
    if (!repo) {
      log("No Git repositories found yet — will listen for new repos");
      const onNewRepo = git.onDidOpenRepository(async (newRepo: any) => {
        log(`Repository discovered: ${newRepo.rootUri.fsPath}`);
        onNewRepo.dispose();
        await this.watchRepo(newRepo as unknown as GitRepository);
      });
      this.disposables.push(onNewRepo);
      return;
    }

    await this.watchRepo(repo);
  }

  private async watchRepo(repo: GitRepository): Promise<void> {
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

      // Step 2: Detect if this is a revert commit
      const repoId = await getRepoId(repoPath);
      const author = await getAuthor(repoPath);
      const message = await getCommitMessage(repoPath);

      await this.detectAndMarkRevert(repoPath, message);

      // Step 3: Send to backend
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

      // Step 4: Display results
      if (result.warnings.length > 0) {
        // Set diagnostics (inline squiggles)
        this.diagnostics.setWarnings(result.warnings, repoPath);

        // Update status bar
        this.statusBar.setWarnings(result.warnings.length);

        // Auto-open dashboard with warnings
        vscode.commands.executeCommand("semanticvcs.showWarnings", result.warnings, repoId);
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

  /**
   * Detect if a commit message indicates a revert, and auto-mark the original.
   */
  private async detectAndMarkRevert(repoPath: string, message: string): Promise<void> {
    // Pattern 1: Revert "original message"
    const revertMsgMatch = message.match(/^Revert "(.+)"/i);
    // Pattern 2: This reverts commit <sha>
    const revertShaMatch = message.match(/This reverts commit ([a-f0-9]{7,40})/i);

    let revertedSha: string | undefined;

    if (revertShaMatch) {
      revertedSha = revertShaMatch[1];
      log(`🔄 Detected revert of commit SHA: ${revertedSha.slice(0, 7)}`);
    } else if (revertMsgMatch) {
      // Find the original commit by message
      const originalMsg = revertMsgMatch[1];
      try {
        const result = await this.execGit(repoPath, `log --format=%H --grep="${originalMsg}" -1`);
        revertedSha = result.trim();
        if (revertedSha) {
          log(`🔄 Detected revert of "${originalMsg}" → ${revertedSha.slice(0, 7)}`);
        }
      } catch {
        log(`Could not find original commit for revert message: "${originalMsg}"`);
      }
    }

    if (revertedSha) {
      try {
        const repoId = await this.execGit(repoPath, "config --get remote.origin.url").catch(() => "");
        await this.apiClient.markRevert({
          repo_id: repoId.trim() || require("path").basename(repoPath),
          commit_sha: revertedSha,
          reason: `Auto-detected from commit message: "${message}"`,
        });
        log(`✅ Marked ${revertedSha.slice(0, 7)} as reverted via webhook`);

        vscode.window.showInformationMessage(
          `SemanticVCS: Auto-detected revert — commit ${revertedSha.slice(0, 7)} marked as reverted`
        );
      } catch (error) {
        logError("Failed to mark revert via webhook", error);
      }
    }
  }

  private execGit(repoPath: string, args: string): Promise<string> {
    return new Promise((resolve, reject) => {
      require("child_process").exec(
        `git ${args}`,
        { cwd: repoPath },
        (err: Error | null, stdout: string) => {
          if (err) { reject(err); } else { resolve(stdout); }
        }
      );
    });
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
