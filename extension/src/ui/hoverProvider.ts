/**
 * Hover Provider — Rich tooltips when hovering over flagged functions.
 *
 * Shows risk level, similarity score, explanation, historical context,
 * and suggested action in a formatted markdown tooltip.
 */

import * as vscode from "vscode";
import { Warning } from "../api/types";

export class HoverProvider implements vscode.HoverProvider, vscode.Disposable {
  private warnings: Map<string, Warning[]> = new Map();
  private registration: vscode.Disposable | undefined;

  /** Register hover provider for all supported languages */
  register(): void {
    this.registration = vscode.languages.registerHoverProvider(
      [
        { language: "python" },
        { language: "javascript" },
        { language: "typescript" },
        { language: "javascriptreact" },
        { language: "typescriptreact" },
      ],
      this
    );
  }

  /** Update the stored warnings */
  setWarnings(warnings: Warning[], repoPath: string): void {
    this.warnings.clear();
    for (const w of warnings) {
      const key = w.file_path;
      if (!this.warnings.has(key)) {
        this.warnings.set(key, []);
      }
      this.warnings.get(key)!.push(w);
    }
  }

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | undefined {
    // Find warnings for this file
    const relativePath = vscode.workspace.asRelativePath(document.uri);
    const fileWarnings = this.warnings.get(relativePath) || [];

    // Find warning at cursor position
    const line = position.line + 1; // Convert 0-indexed to 1-indexed
    const warning = fileWarnings.find(
      (w) => line >= w.start_line && line <= w.end_line
    );

    if (!warning) {
      return undefined;
    }

    // Build rich markdown tooltip
    const simPercent = Math.round(warning.similarity_score * 100);
    const riskEmoji =
      warning.risk_level === "HIGH" ? "🔴" :
        warning.risk_level === "MEDIUM" ? "🟡" : "🔵";

    const matchShort = warning.matched_commit_sha.slice(0, 7);
    const matchDate = warning.matched_date
      ? new Date(warning.matched_date).toLocaleDateString()
      : "unknown date";

    const md = new vscode.MarkdownString();
    md.supportHtml = true;
    md.isTrusted = true;

    md.appendMarkdown(`### ${riskEmoji} SemanticVCS Risk: **${warning.risk_level}**\n\n`);
    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(`**${simPercent}% similar** to commit \`${matchShort}\` (${matchDate})\n\n`);
    md.appendMarkdown(`**Outcome:** \`${warning.outcome.toUpperCase()}\`\n\n`);

    if (warning.explanation) {
      md.appendMarkdown(`**Explanation:**\n${warning.explanation}\n\n`);
    }

    if (warning.historical_context) {
      md.appendMarkdown(`**Historical Context:**\n${warning.historical_context}\n\n`);
    }

    if (warning.suggested_action) {
      md.appendMarkdown(`---\n\n`);
      md.appendMarkdown(`💡 **Suggested Action:**\n${warning.suggested_action}\n`);
    }

    const range = new vscode.Range(
      warning.start_line - 1, 0,
      warning.end_line - 1, Number.MAX_VALUE
    );

    return new vscode.Hover(md, range);
  }

  dispose(): void {
    this.registration?.dispose();
  }
}
