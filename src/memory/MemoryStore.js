const vscode = require("vscode");
const fs = require("fs/promises");
const path = require("path");

const DEFAULT_RELATIVE_PATH = path.join(
  ".aiAgentAssistant",
  "memory",
  "store.json"
);

class MemoryStore {
  constructor(outputChannel) {
    this.outputChannel = outputChannel;
    this.cache = null;
    this.resolvedPath = null;
  }

  invalidate() {
    this.cache = null;
    this.resolvedPath = null;
  }

  resolveStorePath() {
    if (this.resolvedPath) {
      return this.resolvedPath;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return null;
    }

    const configured = String(
      vscode.workspace
        .getConfiguration("aiAgentAssistant")
        .get("memory.storagePath", "") || ""
    ).trim();

    const target = configured
      ? path.isAbsolute(configured)
        ? configured
        : path.join(workspaceFolder.uri.fsPath, configured)
      : path.join(workspaceFolder.uri.fsPath, DEFAULT_RELATIVE_PATH);

    this.resolvedPath = target;
    return target;
  }

  async load() {
    if (this.cache) {
      return this.cache;
    }

    const storePath = this.resolveStorePath();
    if (!storePath) {
      this.cache = { version: 1, entries: [] };
      return this.cache;
    }

    try {
      const raw = await fs.readFile(storePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.entries)) {
        this.cache = { version: 1, entries: parsed.entries };
      } else {
        this.cache = { version: 1, entries: [] };
      }
    } catch (_error) {
      this.cache = { version: 1, entries: [] };
    }

    return this.cache;
  }

  async getEntries() {
    const cache = await this.load();
    return cache.entries.slice();
  }

  async addEntry(entry) {
    const cache = await this.load();
    cache.entries.push(entry);
    await this.save();
  }

  async save() {
    const storePath = this.resolveStorePath();
    if (!storePath) {
      this.outputChannel?.appendLine(
        "[memory] save skipped: no workspace folder resolved (storePath is null)"
      );
      return;
    }
    if (!this.cache) {
      this.outputChannel?.appendLine("[memory] save skipped: cache is empty");
      return;
    }

    try {
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(
        storePath,
        JSON.stringify(this.cache, null, 2),
        "utf8"
      );
      this.outputChannel?.appendLine(
        `[memory] store saved to ${storePath} (entries=${this.cache.entries.length})`
      );
    } catch (error) {
      this.outputChannel?.appendLine(
        `[memory] save failed for ${storePath}: ${error?.message || error}`
      );
    }
  }
}

module.exports = {
  MemoryStore,
};
