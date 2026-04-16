/**
 * Diagnostics Manager — Inline warning squiggles in the editor.
 *
 * Maps backend warnings to VS Code diagnostics (red/yellow/blue squiggles)
 * on the exact lines where risky functions are located.
 */

import * as vscode from "vscode";
import * as path from "path";
import { Warning } from "../api/types";

export class DiagnosticsManager implements vscode.Disposable {
  private collection: vscode.DiagnosticCollection;

  constructor() {
    this.collection = vscode.languages.createDiagnosticCollection("semanticvcs");
  }

  /**
   * Set warnings as inline diagnostics in the editor.
   */
  setWarnings(warnings: Warning[], repoPath: string): void {
    this.collection.clear();

    // Group warnings by file
    const byFile = new Map<string, vscode.Diagnostic[]>();

    for (const w of warnings) {
      const absolutePath = path.isAbsolute(w.file_path)
        ? w.file_path
        : path.join(repoPath, w.file_path);

      const fileUri = vscode.Uri.file(absolutePath);
      const key = fileUri.toString();

      if (!byFile.has(key)) {
        byFile.set(key, []);
      }

      // Create the diagnostic range (convert 1-indexed to 0-indexed)
      const range = new vscode.Range(
        Math.max(0, w.start_line - 1), 0,
        Math.max(0, w.end_line - 1), Number.MAX_VALUE
      );

      // Map risk level to diagnostic severity
      let severity: vscode.DiagnosticSeverity;
      let icon: string;
      switch (w.risk_level) {
        case "HIGH":
          severity = vscode.DiagnosticSeverity.Error;
          icon = "🔴";
          break;
        case "MEDIUM":
          severity = vscode.DiagnosticSeverity.Warning;
          icon = "🟡";
          break;
        default:
          severity = vscode.DiagnosticSeverity.Information;
          icon = "🔵";
      }

      const matchShort = w.matched_commit_sha.slice(0, 7);
      const simPercent = Math.round(w.similarity_score * 100);

      const diagnostic = new vscode.Diagnostic(
        range,
        `${icon} SemanticVCS: ${simPercent}% similar to ${w.outcome} commit ${matchShort} — ${w.explanation}`,
        severity
      );

      diagnostic.source = "SemanticVCS";

      // Add related information
      if (w.suggested_action) {
        diagnostic.relatedInformation = [
          new vscode.DiagnosticRelatedInformation(
            new vscode.Location(fileUri, range),
            `💡 Suggested: ${w.suggested_action}`
          ),
        ];
      }

      byFile.get(key)!.push(diagnostic);
    }

    // Apply diagnostics to each file
    for (const [uriString, diagnostics] of byFile) {
      this.collection.set(vscode.Uri.parse(uriString), diagnostics);
    }
  }

  /** Clear all diagnostics */
  clear(): void {
    this.collection.clear();
  }

  dispose(): void {
    this.collection.dispose();
  }
}
