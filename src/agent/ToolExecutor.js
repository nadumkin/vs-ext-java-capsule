const vscode = require("vscode");
const path = require("path");
const os = require("os");
const fs = require("fs/promises");
const { spawn } = require("child_process");

const DEFAULT_EXCLUDE =
  "**/{node_modules,.git,dist,out,build,coverage,.next,target,vendor}/**";
const MAX_TEXT_FILE_BYTES = 512 * 1024;
const SEARCHABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".json",
  ".md",
  ".mdx",
  ".txt",
  ".yml",
  ".yaml",
  ".xml",
  ".html",
  ".css",
  ".scss",
  ".less",
  ".py",
  ".java",
  ".kt",
  ".kts",
  ".cs",
  ".go",
  ".rb",
  ".php",
  ".sh",
  ".sql",
  ".env",
]);

class ToolExecutor {
  constructor(outputChannel) {
    this.outputChannel = outputChannel;
    this.commandSessions = new Map();
    this.nextSessionId = 1;
    this.nextPendingApprovalId = 1;
    this.nextChangeId = 1;
    this.pendingApproval = null;
    this.decoder = new TextDecoder("utf-8");
  }

  getToolDefinitions() {
    return [
      toolDefinition(
        "read_file",
        "Read a file from the current workspace.",
        {
          path: schemaString("Workspace-relative or absolute path to read."),
        },
        ["path"]
      ),
      toolDefinition(
        "list_workspace_files",
        "List files in the current workspace using a glob pattern.",
        {
          glob: schemaString("Glob pattern, for example **/*.ts"),
          limit: schemaNumber("Maximum number of files to return.", 1),
        }
      ),
      toolDefinition(
        "search_workspace",
        "Search text in workspace files.",
        {
          query: schemaString("Plain text query to search for."),
          limit: schemaNumber("Maximum number of matches to return.", 1),
        },
        ["query"]
      ),
      toolDefinition(
        "write_file",
        "Create or replace a workspace file with the provided full content.",
        {
          path: schemaString("Workspace-relative or absolute path to write."),
          content: schemaString("Full file content."),
        },
        ["path", "content"]
      ),
      toolDefinition(
        "replace_active_file",
        "Replace the entire contents of the currently active editor file.",
        {
          content: schemaString("Full replacement content."),
        },
        ["content"]
      ),
      toolDefinition(
        "run_shell_command",
        "Run a shell command in the workspace and capture stdout/stderr.",
        {
          command: schemaString("Shell command to run."),
          cwd: schemaString("Optional working directory inside the workspace."),
          timeoutMs: schemaNumber("Optional timeout in milliseconds.", 1000),
        },
        ["command"]
      ),
      toolDefinition(
        "run_bash_script",
        "Run a bash script in the workspace and capture stdout/stderr.",
        {
          script: schemaString("Bash script body."),
          cwd: schemaString("Optional working directory inside the workspace."),
          timeoutMs: schemaNumber("Optional timeout in milliseconds.", 1000),
        },
        ["script"]
      ),
      toolDefinition(
        "read_terminal_output",
        "Read captured output from the last managed shell/bash execution.",
        {
          sessionId: schemaNumber("Optional managed session id.", 1),
          maxChars: schemaNumber("Maximum output characters to return.", 1),
        }
      ),
    ];
  }

  isDeferredFileChangeTool(name) {
    return name === "write_file" || name === "replace_active_file";
  }

  getPendingApprovalSummary() {
    if (!this.pendingApproval || this.pendingApproval.changes.length === 0) {
      return "";
    }

    const fileList = this.pendingApproval.changes
      .slice(0, 3)
      .map((change) => change.path)
      .join(", ");
    const suffix =
      this.pendingApproval.changes.length > 3
        ? ` и еще ${this.pendingApproval.changes.length - 3}`
        : "";

    return `Подготовлено ${this.pendingApproval.changes.length} изменений: ${fileList}${suffix}. Проверьте diff и выберите, применять их или отклонить.`;
  }

  async applyPendingChanges() {
    if (!this.pendingApproval) {
      return {
        count: 0,
        files: [],
        summary: "Ожидающих подтверждения изменений нет.",
        displayMessages: [],
      };
    }

    const session = this.pendingApproval;
    this.pendingApproval = null;

    try {
      for (const change of session.changes) {
        await this.writeTextToUri(change.targetUri, change.proposedContent);
      }

      const lastChange = session.changes.at(-1);
      if (lastChange) {
        await this.openTextDocument(lastChange.targetUri);
      }

      return {
        count: session.changes.length,
        files: session.changes.map((change) => change.path),
        summary: `Применено ${session.changes.length} изменений.`,
        displayMessages: session.changes.map((change) =>
          createChangeDisplayMessage({
            id: change.messageId,
            title: change.title,
            path: change.path,
            mode: change.mode,
            status: "applied",
            summary: `Изменение применено: ${change.path}`,
          })
        ),
      };
    } finally {
      await cleanupPendingApprovalSession(session);
    }
  }

  async rejectPendingChanges() {
    if (!this.pendingApproval) {
      return {
        count: 0,
        files: [],
        summary: "Ожидающих подтверждения изменений нет.",
        displayMessages: [],
      };
    }

    const session = this.pendingApproval;
    this.pendingApproval = null;

    try {
      return {
        count: session.changes.length,
        files: session.changes.map((change) => change.path),
        summary: `Отклонено ${session.changes.length} изменений.`,
        displayMessages: session.changes.map((change) =>
          createChangeDisplayMessage({
            id: change.messageId,
            title: change.title,
            path: change.path,
            mode: change.mode,
            status: "rejected",
            summary: `Изменение отклонено: ${change.path}`,
          })
        ),
      };
    } finally {
      await cleanupPendingApprovalSession(session);
    }
  }

  async clearPendingChanges() {
    await this.rejectPendingChanges();
  }

  async executeToolCall(toolCall, hooks = {}) {
    const name = toolCall?.function?.name;
    const id = toolCall?.id || toolCall?.toolCallId;
    const args = parseArguments(toolCall?.function?.arguments);

    let result;
    switch (name) {
      case "read_file":
        result = await this.readFile(args);
        break;
      case "list_workspace_files":
        result = await this.listWorkspaceFiles(args);
        break;
      case "search_workspace":
        result = await this.searchWorkspace(args);
        break;
      case "write_file":
        result = await this.writeFile(args, hooks);
        break;
      case "replace_active_file":
        result = await this.replaceActiveFile(args, hooks);
        break;
      case "run_shell_command":
        result = await this.runShellCommand(args, hooks);
        break;
      case "run_bash_script":
        result = await this.runBashScript(args, hooks);
        break;
      case "read_terminal_output":
        result = await this.readTerminalOutput(args);
        break;
      default:
        throw new Error(`Неизвестный tool call: ${name}`);
    }

    const { displayMessage, ...toolPayload } = result;

    return {
      toolMessage: {
        role: "tool",
        tool_call_id: id,
        name,
        content: JSON.stringify(toolPayload, null, 2),
      },
      summary: toolPayload.summary || `${name} выполнен.`,
      displayMessage,
      requiresApproval: Boolean(toolPayload.requiresApproval),
    };
  }

  async readFile(args) {
    const targetUri = await this.resolvePath(args.path);
    const bytes = await vscode.workspace.fs.readFile(targetUri);
    const content = this.decoder.decode(bytes);
    return {
      ok: true,
      path: toWorkspacePath(targetUri),
      content,
      summary: `Прочитан файл ${toWorkspacePath(targetUri)}`,
    };
  }

  async listWorkspaceFiles(args) {
    const limit = clamp(args.limit || 100, 1, 500);
    const glob = args.glob || "**/*";
    const files = await vscode.workspace.findFiles(glob, DEFAULT_EXCLUDE, limit);
    return {
      ok: true,
      glob,
      files: files.map((uri) => toWorkspacePath(uri)),
      summary: `Получен список файлов по шаблону ${glob}`,
    };
  }

  async searchWorkspace(args) {
    const query = String(args.query || "").trim();
    if (!query) {
      throw new Error("search_workspace требует непустой query.");
    }

    const limit = clamp(args.limit || 30, 1, 100);
    const matches = [];
    const candidateFiles = await vscode.workspace.findFiles("**/*", DEFAULT_EXCLUDE, 500);
    const normalizedQuery = query.toLowerCase();

    for (const uri of candidateFiles) {
      if (matches.length >= limit) {
        break;
      }

      if (!isSearchableFile(uri.fsPath)) {
        continue;
      }

      const content = await readTextFile(uri);
      if (!content) {
        continue;
      }

      const fileMatches = findPlainTextMatches({
        content,
        query: normalizedQuery,
        maxMatches: limit - matches.length,
      });

      for (const match of fileMatches) {
        matches.push({
          path: toWorkspacePath(uri),
          line: match.line,
          preview: match.preview,
        });
      }
    }

    return {
      ok: true,
      query,
      matches,
      summary: `Поиск по workspace: найдено ${matches.length} совпадений для "${query}"`,
    };
  }

  async writeFile(args, hooks = {}) {
    const targetUri = await this.resolvePath(args.path);
    return this.handleFileMutation({
      targetUri,
      proposedContent: String(args.content || ""),
      title: "File change",
      hooks,
    });
  }

  async replaceActiveFile(args, hooks = {}) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      throw new Error("Нет активного редактора для replace_active_file.");
    }

    return this.handleFileMutation({
      targetUri: editor.document.uri,
      proposedContent: String(args.content || ""),
      title: "Active file change",
      hooks,
    });
  }

  async handleFileMutation({ targetUri, proposedContent, title, hooks }) {
    const current = await this.readExistingText(targetUri);
    const pathLabel = toWorkspacePath(targetUri);
    const mode = current.exists ? "update" : "create";

    if (this.getAutoApplyFileChanges()) {
      await this.writeTextToUri(targetUri, proposedContent);
      await this.openTextDocument(targetUri);

      return {
        ok: true,
        path: pathLabel,
        summary: `Изменения автоматически применены: ${pathLabel}`,
        displayMessage: createChangeDisplayMessage({
          id: `file-change-auto-${this.nextChangeId++}`,
          title,
          path: pathLabel,
          mode,
          status: "applied",
          summary: `Изменения применены автоматически: ${pathLabel}`,
        }),
      };
    }

    const stagedChange = await this.stageFileChange({
      targetUri,
      pathLabel,
      originalContent: current.content,
      proposedContent,
      mode,
      title,
    });

    hooks.onEvent?.({
      displayMessage: createChangeDisplayMessage({
        id: stagedChange.messageId,
        title: stagedChange.title,
        path: stagedChange.path,
        mode: stagedChange.mode,
        status: "pending",
        summary: `Открыт diff для проверки: ${stagedChange.path}`,
      }),
    });

    return {
      ok: false,
      requiresApproval: true,
      pendingApproval: true,
      path: stagedChange.path,
      changeId: stagedChange.id,
      summary: `Изменение подготовлено и ожидает подтверждения: ${stagedChange.path}`,
      displayMessage: createChangeDisplayMessage({
        id: stagedChange.messageId,
        title: stagedChange.title,
        path: stagedChange.path,
        mode: stagedChange.mode,
        status: "pending",
        summary: `Изменение ожидает подтверждения: ${stagedChange.path}`,
      }),
    };
  }

  async stageFileChange({
    targetUri,
    pathLabel,
    originalContent,
    proposedContent,
    mode,
    title,
  }) {
    const session = await this.ensurePendingApprovalSession();
    const changeId = `change-${this.nextChangeId++}`;
    const originalPath = path.join(session.tempDir, `${changeId}-original.txt`);
    const proposedPath = path.join(session.tempDir, `${changeId}-proposed.txt`);

    await fs.writeFile(originalPath, originalContent, "utf8");
    await fs.writeFile(proposedPath, proposedContent, "utf8");

    const change = {
      id: changeId,
      messageId: `file-change-${changeId}`,
      title,
      path: pathLabel,
      targetUri,
      originalContent,
      proposedContent,
      mode,
      originalUri: vscode.Uri.file(originalPath),
      proposedUri: vscode.Uri.file(proposedPath),
    };

    session.changes.push(change);

    await vscode.commands.executeCommand(
      "vscode.diff",
      change.originalUri,
      change.proposedUri,
      `AI Agent Diff: ${change.path}`,
      {
        preview: false,
      }
    );

    return change;
  }

  async ensurePendingApprovalSession() {
    if (this.pendingApproval) {
      return this.pendingApproval;
    }

    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), `ai-agent-assistant-${this.nextPendingApprovalId}-`)
    );
    this.pendingApproval = {
      id: this.nextPendingApprovalId++,
      tempDir,
      changes: [],
    };
    return this.pendingApproval;
  }

  async readExistingText(uri) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return {
        exists: true,
        content: this.decoder.decode(bytes),
      };
    } catch (_error) {
      return {
        exists: false,
        content: "",
      };
    }
  }

  getAutoApplyFileChanges() {
    return Boolean(
      vscode.workspace
        .getConfiguration("aiAgentAssistant")
        .get("execution.autoApplyFileChanges", false)
    );
  }

  async writeTextToUri(uri, content) {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
  }

  async runShellCommand(args, hooks = {}) {
    const command = String(args.command || "").trim();
    if (!command) {
      throw new Error("run_shell_command требует непустой command.");
    }

    const cwd = await this.resolveCwd(args.cwd);

    const allowed = await this.confirmExecution("shell-команду", command);
    if (!allowed) {
      return {
        ok: false,
        cancelled: true,
        summary: `Запуск команды отменен пользователем: ${command}`,
        displayMessage: createCommandDisplayMessage({
          title: "Shell command",
          commandText: command,
          cwd,
          status: "cancelled",
          summary: "Запуск команды отменен пользователем.",
        }),
      };
    }

    const execution = await this.executeProcess({
      label: command,
      command,
      cwd,
      timeoutMs: clampCommandTimeout(args.timeoutMs),
      shell: true,
      onUpdate: hooks.onEvent,
      title: "Shell command",
      commandText: command,
    });

    return {
      ...execution,
      displayMessage: createCommandDisplayMessage({
        title: "Shell command",
        commandText: command,
        cwd: execution.cwd,
        sessionId: execution.sessionId,
        exitCode: execution.exitCode,
        timedOut: execution.timedOut,
        stdout: execution.stdout,
        stderr: execution.stderr,
        status: execution.timedOut
          ? "timeout"
          : execution.exitCode === 0
            ? "success"
            : "error",
        summary: execution.summary,
      }),
    };
  }

  async runBashScript(args, hooks = {}) {
    const script = String(args.script || "").trim();
    if (!script) {
      throw new Error("run_bash_script требует непустой script.");
    }

    if (process.platform === "win32") {
      throw new Error("run_bash_script не поддерживается на Windows без bash.");
    }

    const cwd = await this.resolveCwd(args.cwd);

    const allowed = await this.confirmExecution("bash-скрипт", script);
    if (!allowed) {
      return {
        ok: false,
        cancelled: true,
        summary: "Запуск bash-скрипта отменен пользователем.",
        displayMessage: createCommandDisplayMessage({
          title: "Bash script",
          commandText: script,
          cwd,
          status: "cancelled",
          summary: "Запуск bash-скрипта отменен пользователем.",
        }),
      };
    }

    const execution = await this.executeProcess({
      label: "bash script",
      command: "/bin/bash",
      args: ["-lc", script],
      cwd,
      timeoutMs: clampCommandTimeout(args.timeoutMs),
      shell: false,
      onUpdate: hooks.onEvent,
      title: "Bash script",
      commandText: script,
    });

    return {
      ...execution,
      displayMessage: createCommandDisplayMessage({
        title: "Bash script",
        commandText: script,
        cwd: execution.cwd,
        sessionId: execution.sessionId,
        exitCode: execution.exitCode,
        timedOut: execution.timedOut,
        stdout: execution.stdout,
        stderr: execution.stderr,
        status: execution.timedOut
          ? "timeout"
          : execution.exitCode === 0
            ? "success"
            : "error",
        summary: execution.summary,
      }),
    };
  }

  async readTerminalOutput(args) {
    const sessionId = Number(args.sessionId || 0);
    const maxChars = clamp(args.maxChars || 12000, 100, 50000);
    const session =
      (sessionId && this.commandSessions.get(sessionId)) ||
      [...this.commandSessions.values()].at(-1);

    if (!session) {
      return {
        ok: false,
        summary: "Управляемые shell-сессии еще не запускались.",
      };
    }

    const output = `${session.stdout}${session.stderr}`.slice(-maxChars);
    return {
      ok: true,
      sessionId: session.id,
      command: session.command,
      exitCode: session.exitCode,
      output,
      summary: `Прочитан вывод managed terminal session #${session.id}`,
      displayMessage: createCommandDisplayMessage({
        title: "Managed terminal output",
        commandText: session.command,
        cwd: session.cwd,
        sessionId: session.id,
        exitCode: session.exitCode,
        output,
        status: "info",
        summary: `Последний вывод session #${session.id}`,
      }),
    };
  }

  async executeProcess({
    label,
    command,
    args = [],
    cwd,
    timeoutMs,
    shell,
    onUpdate,
    title,
    commandText,
  }) {
    const sessionId = this.nextSessionId++;
    this.outputChannel.appendLine(`[${sessionId}] ${label}`);

    const session = {
      id: sessionId,
      command: Array.isArray(args) && args.length > 0 ? `${command} ${args.join(" ")}` : command,
      cwd,
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: false,
    };
    this.commandSessions.set(sessionId, session);
    const messageId = `command-session-${sessionId}`;

    return new Promise((resolve, reject) => {
      let lastUpdateAt = 0;
      const emitUpdate = (status, summary) => {
        if (!onUpdate) {
          return;
        }

        onUpdate({
          displayMessage: createCommandDisplayMessage({
            id: messageId,
            title: title || "Command",
            commandText: commandText || session.command,
            cwd,
            sessionId,
            exitCode: session.exitCode,
            timedOut: session.timedOut,
            stdout: session.stdout,
            stderr: session.stderr,
            status,
            summary,
          }),
        });
      };

      const child = spawn(command, args, {
        cwd,
        shell,
        env: process.env,
      });

      emitUpdate("running", `Команда запущена: ${session.command}`);

      const timeout = setTimeout(() => {
        session.timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        session.stdout += text;
        this.outputChannel.append(text);
        const now = Date.now();
        if (now - lastUpdateAt >= 150) {
          lastUpdateAt = now;
          emitUpdate("running", `Команда выполняется: ${session.command}`);
        }
      });

      child.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        session.stderr += text;
        this.outputChannel.append(text);
        const now = Date.now();
        if (now - lastUpdateAt >= 150) {
          lastUpdateAt = now;
          emitUpdate("running", `Команда выполняется: ${session.command}`);
        }
      });

      child.on("error", (error) => {
        clearTimeout(timeout);
        emitUpdate("error", `Ошибка запуска команды: ${error.message}`);
        reject(error);
      });

      child.on("close", (code) => {
        clearTimeout(timeout);
        session.exitCode = code;
        emitUpdate(
          session.timedOut
            ? "timeout"
            : code === 0
              ? "success"
              : "error",
          session.timedOut
            ? `Команда остановлена по timeout: ${session.command}`
            : `Команда завершена с кодом ${code}: ${session.command}`
        );

        resolve({
          ok: code === 0 && !session.timedOut,
          sessionId,
          command: session.command,
          cwd,
          exitCode: code,
          timedOut: session.timedOut,
          stdout: session.stdout,
          stderr: session.stderr,
          summary: session.timedOut
            ? `Команда остановлена по timeout: ${session.command}`
            : `Команда завершена с кодом ${code}: ${session.command}`,
        });
      });
    });
  }

  async resolvePath(inputPath) {
    if (!inputPath) {
      throw new Error("Path is required.");
    }

    const activeEditor = vscode.window.activeTextEditor;
    const workspaceFolder =
      (activeEditor && vscode.workspace.getWorkspaceFolder(activeEditor.document.uri)) ||
      vscode.workspace.workspaceFolders?.[0];

    let resolvedPath;
    if (path.isAbsolute(inputPath)) {
      resolvedPath = inputPath;
    } else if (inputPath.startsWith("./") || inputPath.startsWith("../")) {
      if (activeEditor) {
        resolvedPath = path.resolve(path.dirname(activeEditor.document.uri.fsPath), inputPath);
      }
    } else if (workspaceFolder) {
      resolvedPath = path.join(workspaceFolder.uri.fsPath, inputPath);
    }

    if (!resolvedPath) {
      throw new Error(`Не удалось разрешить путь ${inputPath}`);
    }

    if (!this.isInsideWorkspace(resolvedPath)) {
      throw new Error(`Путь вне workspace запрещен: ${inputPath}`);
    }

    return vscode.Uri.file(resolvedPath);
  }

  async resolveCwd(rawCwd) {
    if (!rawCwd) {
      const activeEditor = vscode.window.activeTextEditor;
      const workspaceFolder =
        (activeEditor &&
          vscode.workspace.getWorkspaceFolder(activeEditor.document.uri)) ||
        vscode.workspace.workspaceFolders?.[0];
      return workspaceFolder?.uri.fsPath || process.cwd();
    }

    return (await this.resolvePath(rawCwd)).fsPath;
  }

  isInsideWorkspace(candidatePath) {
    const folders = vscode.workspace.workspaceFolders || [];
    return folders.some((folder) => {
      const relative = path.relative(folder.uri.fsPath, candidatePath);
      return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
    }) || folders.some((folder) => folder.uri.fsPath === candidatePath);
  }

  async confirmExecution(kind, payload) {
    const requireConfirmation = vscode.workspace
      .getConfiguration("aiAgentAssistant")
      .get("execution.requireConfirmation", true);

    if (!requireConfirmation) {
      return true;
    }

    const answer = await vscode.window.showWarningMessage(
      `Разрешить агенту запустить ${kind}?\n${payload}`,
      { modal: true },
      "Запустить"
    );

    return answer === "Запустить";
  }

  async openTextDocument(uri) {
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (_error) {
      return undefined;
    }
  }
}

async function cleanupPendingApprovalSession(session) {
  if (!session?.tempDir) {
    return;
  }

  try {
    await fs.rm(session.tempDir, { recursive: true, force: true });
  } catch (_error) {
    return;
  }
}

function toolDefinition(name, description, properties, required = []) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    },
  };
}

function schemaString(description) {
  return {
    type: "string",
    description,
  };
}

function schemaNumber(description, minimum) {
  return {
    type: "number",
    description,
    minimum,
  };
}

function parseArguments(raw) {
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (_error) {
    throw new Error(`Не удалось распарсить tool arguments: ${raw}`);
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function clampCommandTimeout(value) {
  const configured = vscode.workspace
    .getConfiguration("aiAgentAssistant")
    .get("execution.commandTimeoutMs", 120000);
  return clamp(value || configured, 1000, 900000);
}

function toWorkspacePath(uri) {
  return vscode.workspace.asRelativePath(uri, false) || uri.fsPath;
}

function isSearchableFile(fsPath) {
  const extension = path.extname(fsPath).toLowerCase();
  return SEARCHABLE_EXTENSIONS.has(extension) || path.basename(fsPath).startsWith(".");
}

async function readTextFile(uri) {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > MAX_TEXT_FILE_BYTES) {
      return "";
    }

    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString("utf8");
  } catch (_error) {
    return "";
  }
}

function findPlainTextMatches({ content, query, maxMatches }) {
  const lines = content.split(/\r?\n/);
  const matches = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.toLowerCase().includes(query)) {
      continue;
    }

    matches.push({
      line: index + 1,
      preview: line.trim(),
    });

    if (matches.length >= maxMatches) {
      break;
    }
  }

  return matches;
}

function createCommandDisplayMessage({
  id,
  title,
  commandText,
  cwd,
  sessionId,
  exitCode,
  timedOut,
  stdout,
  stderr,
  output,
  status,
  summary,
}) {
  return {
    id,
    role: "command",
    kind: "command",
    title,
    commandText,
    cwd,
    sessionId,
    exitCode,
    timedOut: Boolean(timedOut),
    stdout: truncateForDisplay(stdout),
    stderr: truncateForDisplay(stderr),
    output: truncateForDisplay(output),
    status: status || "info",
    summary,
  };
}

function createChangeDisplayMessage({
  id,
  title,
  path: filePath,
  mode,
  status,
  summary,
}) {
  return {
    id,
    role: "change",
    kind: "change",
    title,
    path: filePath,
    mode,
    status,
    summary,
  };
}

function truncateForDisplay(value, maxChars = 12000) {
  const text = String(value || "");
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`;
}

module.exports = {
  ToolExecutor,
};
