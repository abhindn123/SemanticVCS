/**
 * Status Bar Manager — Shows SemanticVCS status in the VS Code status bar.
 *
 * States:
 *   $(shield) SemanticVCS — Ready
 *   $(sync~spin) Analyzing...
 *   $(shield-check) Clean — No risks
 *   $(warning) 2 warnings
 *   $(error) Error
 */

import * as vscode from "vscode";

export class StatusBarManager implements vscode.Disposable {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = "semanticvcs.dashboard";
    this.item.show();
  }

  /** Show a custom status */
  show(text: string, tooltip: string): void {
    this.item.text = text;
    this.item.tooltip = tooltip;
    this.item.backgroundColor = undefined;
  }

  /** Set status: Analyzing */
  setAnalyzing(): void {
    this.item.text = "$(sync~spin) SemanticVCS";
    this.item.tooltip = "Analyzing commit...";
    this.item.backgroundColor = undefined;
  }

  /** Set status: Clean (no warnings) */
  setClean(): void {
    this.item.text = "$(shield-check) SemanticVCS";
    this.item.tooltip = "No risks detected";
    this.item.backgroundColor = undefined;
  }

  /** Set status: Warnings found */
  setWarnings(count: number): void {
    this.item.text = `$(warning) SemanticVCS: ${count} warning${count !== 1 ? "s" : ""}`;
    this.item.tooltip = `${count} semantic risk warning${count !== 1 ? "s" : ""} — Click to view dashboard`;
    this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  }

  /** Set status: Error */
  setError(message: string): void {
    this.item.text = "$(error) SemanticVCS";
    this.item.tooltip = message;
    this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  }

  dispose(): void {
    this.item.dispose();
  }
}
