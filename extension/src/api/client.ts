/**
 * API Client — HTTP client for communicating with the SemanticVCS backend.
 *
 * Handles authentication, request/response, retries, and error handling.
 */

import * as vscode from "vscode";
import { AnalyzeRequest, AnalyzeResponse, AuthResponse, HealthResponse, HistoryStats } from "./types";

export class ApiClient {
  private context: vscode.ExtensionContext;
  private readonly API_KEY_SECRET = "semanticvcs.apiKey";

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /** Get the configured API URL from settings */
  private getBaseUrl(): string {
    const config = vscode.workspace.getConfiguration("semanticvcs");
    return config.get<string>("apiUrl", "https://semanticvcs-api.up.railway.app");
  }

  /** Get stored API key from VS Code SecretStorage */
  async getApiKey(): Promise<string | undefined> {
    return await this.context.secrets.get(this.API_KEY_SECRET);
  }

  /** Store API key in VS Code SecretStorage (encrypted) */
  async setApiKey(key: string): Promise<void> {
    await this.context.secrets.store(this.API_KEY_SECRET, key);
  }

  /** Prompt user to enter their API key */
  async promptApiKey(): Promise<string | undefined> {
    const key = await vscode.window.showInputBox({
      prompt: "Enter your SemanticVCS API key",
      password: true,
      placeHolder: "svcs_xxxxxxxxxxxxx",
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value) { return "API key is required"; }
        if (!value.startsWith("svcs_")) { return "API key should start with 'svcs_'"; }
        return null;
      },
    });

    if (key) {
      await this.setApiKey(key);
      vscode.window.showInformationMessage("✅ SemanticVCS API key saved securely");
    }
    return key;
  }

  /** Make an authenticated request to the backend */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    retries: number = 3
  ): Promise<T> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error("API key not set. Run 'SemanticVCS: Set API Key' first.");
    }

    const url = `${this.getBaseUrl()}${path}`;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

        const response = await fetch(url, {
          method,
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const errorBody = await response.text();

          if (response.status === 401) {
            throw new Error("Invalid API key. Run 'SemanticVCS: Set API Key' to update.");
          }
          if (response.status === 429) {
            throw new Error("Rate limit exceeded. Please wait and try again.");
          }
          if (response.status === 503) {
            throw new Error("Backend is still starting up. Please try again in a moment.");
          }

          throw new Error(`API error (${response.status}): ${errorBody}`);
        }

        return (await response.json()) as T;
      } catch (error: any) {
        lastError = error;

        // Don't retry auth or rate limit errors
        if (error.message?.includes("API key") || error.message?.includes("Rate limit")) {
          throw error;
        }

        // Exponential backoff
        if (attempt < retries - 1) {
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError || new Error("Request failed after retries");
  }

  /** POST /api/v1/analyze — Analyze a commit */
  async analyze(payload: AnalyzeRequest): Promise<AnalyzeResponse> {
    return this.request<AnalyzeResponse>("POST", "/api/v1/analyze", payload);
  }

  /** GET /health — Check backend health */
  async healthCheck(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/health", undefined, 1);
  }

  /** GET /api/v1/history/{repo_id}/stats — Get warning stats */
  async getStats(repoId: string): Promise<HistoryStats> {
    return this.request<HistoryStats>("GET", `/api/v1/history/${encodeURIComponent(repoId)}/stats`);
  }

  /** Check if API key is configured */
  async hasApiKey(): Promise<boolean> {
    const key = await this.getApiKey();
    return !!key;
  }
}
