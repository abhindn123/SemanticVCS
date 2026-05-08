/**
 * Git Diff Parser — Extracts diff and file content using VS Code's Git API.
 */

import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import { FileDiff } from "../api/types";
import { log, logError } from "../utils/logger";

/** Map file extensions to language names */
const LANGUAGE_MAP: Record<string, string> = {
  ".py": "python",
  ".js": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mjs": "javascript",
  ".cjs": "javascript",
};

/**
 * Execute a git command in the repo directory.
 */
function execGit(repoPath: string, args: string): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.exec(
      `git ${args}`,
      { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 }, // 10MB buffer
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
 * Get the repository remote URL as a repo identifier.
 */
export async function getRepoId(repoPath: string): Promise<string> {
  try {
    const remoteUrl = (await execGit(repoPath, "config --get remote.origin.url")).trim();
    // Normalize: git@github.com:user/repo.git → github.com/user/repo
    return remoteUrl
      .replace(/^git@/, "")
      .replace(/^https?:\/\//, "")
      .replace(":", "/")
      .replace(/\.git$/, "");
  } catch {
    // Fallback to folder name
    return path.basename(repoPath);
  }
}

/**
 * Get the author email from git config.
 */
export async function getAuthor(repoPath: string): Promise<string> {
  try {
    return (await execGit(repoPath, "config user.email")).trim();
  } catch {
    return "";
  }
}

/**
 * Get the latest commit message.
 */
export async function getCommitMessage(repoPath: string): Promise<string> {
  try {
    return (await execGit(repoPath, "log -1 --format=%s")).trim();
  } catch {
    return "";
  }
}

/**
 * Get the latest commit SHA.
 */
export async function getLatestCommitSha(repoPath: string): Promise<string> {
  try {
    return (await execGit(repoPath, "rev-parse HEAD")).trim();
  } catch {
    return "";
  }
}

/**
 * Extract diffs for all changed files in the latest commit.
 *
 * Returns an array of FileDiff objects ready to send to the backend.
 */
export async function extractDiffs(repoPath: string): Promise<FileDiff[]> {
  const diffs: FileDiff[] = [];

  try {
    // Get list of changed files in the latest commit
    const changedFiles = (await execGit(repoPath, "diff-tree --no-commit-id --name-only -r HEAD"))
      .trim()
      .split(/\r?\n/)
      .map((f) => f.trim())
      .filter((f) => f.length > 0);

    log(`Changed files: ${changedFiles.join(", ")}`);

    for (const filePath of changedFiles) {
      const ext = path.extname(filePath);
      const language = LANGUAGE_MAP[ext];

      // Skip unsupported file types
      if (!language) {
        log(`Skipping ${filePath} (unsupported language)`);
        continue;
      }

      try {
        // Get unified diff for this file
        const diff = await execGit(repoPath, `diff HEAD~1 HEAD -- "${filePath}"`);

        // Get current file content
        const fileContent = await execGit(repoPath, `show HEAD:"${filePath}"`);

        if (diff && fileContent) {
          diffs.push({
            file_path: filePath,
            language,
            diff,
            file_content: fileContent,
          });
          log(`Extracted diff for ${filePath} (${language})`);
        }
      } catch (fileError) {
        // File might be new (no HEAD~1) — get the whole file as diff
        logError(`Failed to get diff for ${filePath}`, fileError);

        try {
          const fileContent = await execGit(repoPath, `show HEAD:"${filePath}"`);
          if (fileContent) {
            diffs.push({
              file_path: filePath,
              language,
              diff: `@@ -0,0 +1,${fileContent.split("\n").length} @@\n` +
                fileContent.split("\n").map((l) => `+${l}`).join("\n"),
              file_content: fileContent,
            });
          }
        } catch {
          logError(`Could not read ${filePath} at all`);
        }
      }
    }
  } catch (error) {
    logError("Failed to extract diffs", error);
  }

  return diffs;
}
