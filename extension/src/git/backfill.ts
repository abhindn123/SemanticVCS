/**
 * Git History Backfill — Walks git log and sends historical commits to backend.
 *
 * Extracts diffs for each historical commit and sends them in batches
 * to the /api/v1/backfill endpoint for embedding and revert detection.
 */

import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import { ApiClient } from "../api/client";
import { BackfillCommit } from "../api/types";
import { log, logError } from "../utils/logger";

const BATCH_SIZE = 1; // 1 commit per API call (UniXCoder on CPU is slow)
const MAX_COMMITS = 200; // Max commits to backfill
const MAX_FILES_PER_COMMIT = 5; // Max code files per commit
const MAX_FILE_LINES = 500; // Truncate large files to avoid long embedding times

const LANGUAGE_MAP: Record<string, string> = {
  ".py": "python",
  ".js": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mjs": "javascript",
  ".cjs": "javascript",
};

function execGit(repoPath: string, args: string): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.exec(
      `git ${args}`,
      { cwd: repoPath, maxBuffer: 20 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
        } else {
          resolve(stdout);
        }
      }
    );
  });
}

/**
 * Get the repo ID (same logic as diffParser).
 */
async function getRepoId(repoPath: string): Promise<string> {
  try {
    const remoteUrl = (await execGit(repoPath, "config --get remote.origin.url")).trim();
    return remoteUrl
      .replace(/^git@/, "")
      .replace(/^https?:\/\//, "")
      .replace(":", "/")
      .replace(/\.git$/, "");
  } catch {
    return path.basename(repoPath);
  }
}

/**
 * Get list of commit SHAs and messages from git log.
 */
async function getCommitLog(
  repoPath: string,
  maxCommits: number
): Promise<{ sha: string; message: string; author: string }[]> {
  const output = await execGit(
    repoPath,
    `log --format="%H|||%s|||%ae" --max-count=${maxCommits}`
  );

  return output
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split("|||");
      return {
        sha: parts[0]?.trim() || "",
        message: parts[1]?.trim() || "",
        author: parts[2]?.trim() || "",
      };
    })
    .filter((c) => c.sha.length > 0);
}

/**
 * Get the diff for a specific commit.
 */
async function getCommitDiff(
  repoPath: string,
  sha: string
): Promise<{ file_path: string; language: string; diff: string; file_content: string }[]> {
  const diffs: { file_path: string; language: string; diff: string; file_content: string }[] = [];

  try {
    // Get changed files (--root handles the first commit in repo)
    const changedFiles = (
      await execGit(repoPath, `diff-tree --root --no-commit-id --name-only -r ${sha}`)
    )
      .trim()
      .split(/\r?\n/)
      .map((f) => f.trim())
      .filter((f) => f.length > 0);

    for (const filePath of changedFiles) {
      if (diffs.length >= MAX_FILES_PER_COMMIT) {
        log(`    ⚡ Reached max ${MAX_FILES_PER_COMMIT} files for this commit, skipping rest`);
        break;
      }
      const ext = path.extname(filePath);
      const language = LANGUAGE_MAP[ext];
      if (!language) {
        continue;
      }

      try {
        // Try normal diff first (works for non-root commits)
        const diff = await execGit(repoPath, `diff ${sha}~1 ${sha} -- "${filePath}"`);
        let fileContent = await execGit(repoPath, `show ${sha}:"${filePath}"`);

        if (diff && fileContent) {
          // Truncate large files to keep embedding fast
          const contentLines = fileContent.split("\n");
          if (contentLines.length > MAX_FILE_LINES) {
            fileContent = contentLines.slice(0, MAX_FILE_LINES).join("\n");
          }
          diffs.push({ file_path: filePath, language, diff, file_content: fileContent });
        } else {
          log(`    ⚠️ diff or content empty for ${filePath}`);
        }
      } catch (err: any) {
        log(`    ⚠️ diff failed for ${filePath}: ${err.message?.slice(0, 120)}`);
        // Root commit or file doesn't exist in parent — generate a synthetic diff
        try {
          let fileContent = await execGit(repoPath, `show ${sha}:"${filePath}"`);
          if (fileContent) {
            // Truncate large files
            const lines = fileContent.split("\n");
            if (lines.length > MAX_FILE_LINES) {
              fileContent = lines.slice(0, MAX_FILE_LINES).join("\n");
            }
            const truncLines = fileContent.split("\n");
            const fakeDiff =
              `@@ -0,0 +1,${truncLines.length} @@\n` +
              truncLines.map((l) => `+${l}`).join("\n");
            diffs.push({ file_path: filePath, language, diff: fakeDiff, file_content: fileContent });
          }
        } catch (err2: any) {
          log(`    ❌ show also failed for ${filePath}: ${err2.message?.slice(0, 120)}`);
        }
      }
    }
  } catch (err: any) {
    log(`diff-tree failed for ${sha.slice(0, 7)}: ${err.message}`);
  }

  return diffs;
}

/**
 * Run the full backfill process with a progress bar.
 */
export async function runBackfill(
  apiClient: ApiClient,
  repoPath: string
): Promise<void> {
  log("Starting backfill...");

  // Check API key
  if (!(await apiClient.hasApiKey())) {
    await apiClient.promptApiKey();
    if (!(await apiClient.hasApiKey())) {
      vscode.window.showErrorMessage("SemanticVCS: API key required for backfill");
      return;
    }
  }

  const repoId = await getRepoId(repoPath);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "SemanticVCS: Backfilling repository history",
      cancellable: true,
    },
    async (progress, cancelToken) => {
      // Step 1: Get commit log
      progress.report({ message: "Reading git history...", increment: 0 });
      const commits = await getCommitLog(repoPath, MAX_COMMITS);

      if (commits.length === 0) {
        vscode.window.showInformationMessage("SemanticVCS: No commits found to backfill");
        return;
      }

      log(`Found ${commits.length} commits to backfill`);
      progress.report({
        message: `Found ${commits.length} commits. Extracting diffs...`,
        increment: 5,
      });

      // Step 2: Process in batches
      let totalProcessed = 0;
      let totalEmbedded = 0;
      let totalReverts = 0;
      const incrementPerBatch = 90 / Math.ceil(commits.length / BATCH_SIZE);

      for (let i = 0; i < commits.length; i += BATCH_SIZE) {
        if (cancelToken.isCancellationRequested) {
          log("Backfill cancelled by user");
          break;
        }

        const batch = commits.slice(i, i + BATCH_SIZE);
        const backfillCommits: BackfillCommit[] = [];

        // Extract diffs for each commit in the batch
        for (const commit of batch) {
          progress.report({
            message: `Processing commit ${i + backfillCommits.length + 1}/${commits.length}: ${commit.sha.slice(0, 7)}`,
          });

          const diffs = await getCommitDiff(repoPath, commit.sha);
          log(`  ${commit.sha.slice(0, 7)}: ${diffs.length} file(s)${diffs.length > 0 ? ` [${diffs.map(d => d.file_path).join(', ')}]` : ' (skip)'}`);
          backfillCommits.push({
            sha: commit.sha,
            message: commit.message,
            author: commit.author,
            diffs,
          });
        }

        // Skip if ALL commits in batch have 0 code files
        const totalDiffs = backfillCommits.reduce((sum, c) => sum + c.diffs.length, 0);
        if (totalDiffs === 0) {
          log(`  → Skipped batch (no code files)`);
          progress.report({ increment: incrementPerBatch });
          continue;
        }

        // Send batch to backend
        try {
          const result = await apiClient.backfill({
            repo_id: repoId,
            commits: backfillCommits,
          });

          totalProcessed += result.commits_processed;
          totalEmbedded += result.functions_embedded;
          totalReverts += result.reverts_detected;

          log(
            `  ✅ ${result.commits_processed} processed, ` +
            `${result.functions_embedded} embedded, ` +
            `${result.reverts_detected} reverts`
          );
        } catch (error) {
          logError(`Batch failed at commit ${i}`, error);
          // Continue with next batch instead of stopping entirely
        }

        progress.report({ increment: incrementPerBatch });
      }

      // Step 3: Done
      progress.report({ message: "Backfill complete!", increment: 100 });

      const msg =
        `✅ SemanticVCS Backfill Complete\n` +
        `• ${totalProcessed} commits processed\n` +
        `• ${totalEmbedded} functions embedded\n` +
        `• ${totalReverts} reverts auto-detected`;

      log(msg);
      vscode.window.showInformationMessage(
        `SemanticVCS: Backfilled ${totalProcessed} commits, ` +
        `${totalEmbedded} functions embedded, ` +
        `${totalReverts} reverts detected`
      );
    }
  );
}
