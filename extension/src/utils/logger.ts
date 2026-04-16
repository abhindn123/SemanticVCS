/**
 * Logger — Output channel for SemanticVCS extension logging.
 */

import * as vscode from "vscode";

let outputChannel: vscode.OutputChannel;

export function getLogger(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("SemanticVCS");
  }
  return outputChannel;
}

export function log(message: string): void {
  const timestamp = new Date().toISOString().slice(11, 19);
  getLogger().appendLine(`[${timestamp}] ${message}`);
}

export function logError(message: string, error?: unknown): void {
  const timestamp = new Date().toISOString().slice(11, 19);
  const errorMsg = error instanceof Error ? error.message : String(error || "");
  getLogger().appendLine(`[${timestamp}] ❌ ${message}${errorMsg ? `: ${errorMsg}` : ""}`);
}

export function logWarning(message: string): void {
  const timestamp = new Date().toISOString().slice(11, 19);
  getLogger().appendLine(`[${timestamp}] ⚠️ ${message}`);
}
