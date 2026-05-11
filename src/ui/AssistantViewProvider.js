const vscode = require("vscode");

const DEFAULT_PROMPT =
  "Проанализируй текущий контекст и выполни самое полезное следующее действие.";

class AssistantViewProvider {
  static viewType = "aiAgentAssistant.chatView";

  constructor(context, runtime, openRouterClient) {
    this.context = context;
    this.runtime = runtime;
    this.openRouterClient = openRouterClient;
    this.view = undefined;
    this.messages = [];
    this.busy = false;
    this.status = "";
    this.contextPreview = "Откройте файл с классом, чтобы подготовить контекст.";
    this.iterationLimit = this.getConfiguredIterationLimit();
    this.modelName = this.getConfiguredModelName();
    this.baseUrl = this.getConfiguredBaseUrl();
    this.autoApplyChanges = this.getConfiguredAutoApplyChanges();
    this.hasStoredApiKey = false;
    this.pendingContinuation = undefined;
    this.continuationMessage = "";
    this.pendingApproval = undefined;
    this.approvalMessage = "";
    this.pendingOpenSettings = false;
  }

  async resolveWebviewView(webviewView) {
    this.view = webviewView;
    const webview = webviewView.webview;

    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };

    webview.html = this.getHtml(webview);

    webview.onDidReceiveMessage(async (message) => {
      switch (message?.type) {
        case "ready":
          await this.reloadConfigurationState();
          await this.refreshContextPreview();
          this.postState();
          if (this.pendingOpenSettings) {
            this.pendingOpenSettings = false;
            this.postOpenSettings();
          }
          break;
        case "submitPrompt":
          await this.handleSubmitPrompt(message.prompt);
          break;
        case "continueRun":
          await this.handleContinueRun();
          break;
        case "applyPendingChanges":
          await this.handlePendingApproval(true);
          break;
        case "rejectPendingChanges":
          await this.handlePendingApproval(false);
          break;
        case "saveSettings":
          await this.saveSettings(message.settings);
          break;
        case "clearChat":
          await this.clearChat();
          break;
        case "refreshContext":
          await this.refreshContextPreview();
          break;
        default:
          break;
      }
    });
  }

  async focus() {
    await vscode.commands.executeCommand(
      "workbench.view.extension.aiAgentAssistantContainer"
    );
  }

  async openSettings() {
    if (!this.view) {
      this.pendingOpenSettings = true;
      await this.focus();
      return;
    }

    this.postOpenSettings();
  }

  postOpenSettings() {
    if (!this.view) {
      this.pendingOpenSettings = true;
      return;
    }

    this.view.webview.postMessage({
      type: "openSettings",
    });
  }

  async clearChat() {
    if (this.pendingApproval) {
      await this.runtime.rejectPendingChanges();
    }

    this.messages = [];
    this.status = "";
    this.pendingContinuation = undefined;
    this.continuationMessage = "";
    this.pendingApproval = undefined;
    this.approvalMessage = "";
    this.postState();
  }

  async saveSettings(rawSettings) {
    if (this.busy) {
      return false;
    }

    this.busy = true;
    this.status = "Сохраняю настройки...";
    this.postState();

    try {
      const settings = this.normalizeSettingsPayload(rawSettings);
      const connection = await this.openRouterClient.saveConnectionSettings({
        apiKey: settings.apiKey,
        model: settings.model,
        baseUrl: settings.baseUrl,
        clearApiKey: settings.clearApiKey,
      });

      const target = this.getConfigurationTarget();
      await vscode.workspace
        .getConfiguration("aiAgentAssistant")
        .update("agent.maxIterations", settings.iterationLimit, target);
      await vscode.workspace
        .getConfiguration("aiAgentAssistant")
        .update("execution.autoApplyFileChanges", settings.autoApplyChanges, target);

      this.iterationLimit = settings.iterationLimit;
      this.modelName = connection.model;
      this.baseUrl = connection.baseUrl;
      this.autoApplyChanges = settings.autoApplyChanges;
      this.hasStoredApiKey = connection.hasStoredApiKey;
      this.postInfo(
        `Настройки сохранены. Endpoint: ${this.baseUrl}. Модель: ${this.modelName}.`
      );
      return true;
    } catch (error) {
      this.messages.push(
        this.createMessage(
          "assistant",
          `Ошибка при сохранении настроек:\n${error.message}`
        )
      );
      return false;
    } finally {
      this.busy = false;
      this.status = "";
      this.postState();
    }
  }

  async refreshContextPreview() {
    try {
      const preview = await this.runtime.previewContext();
      this.contextPreview = preview.summaryText;
    } catch (error) {
      this.contextPreview = error.message;
    }

    this.postState();
  }

  async handleSubmitPrompt(rawPrompt) {
    if (this.busy) {
      return;
    }

    if (this.pendingApproval) {
      this.postInfo("Сначала примените или отклоните предложенные изменения.");
      return;
    }

    this.pendingContinuation = undefined;
    this.continuationMessage = "";
    this.pendingApproval = undefined;
    this.approvalMessage = "";

    const prompt = String(rawPrompt || "").trim() || DEFAULT_PROMPT;
    this.messages.push(this.createMessage("user", prompt));
    this.busy = true;
    this.status = "Собираю контекст...";
    this.postState();

    try {
      await this.runAgentTurn({
        prompt,
        history: this.messages
          .slice(0, -1)
          .filter((message) => message.role === "user" || message.role === "assistant")
          .map((message) => ({
            role: message.role,
            content: message.content,
          })),
        iterationLimit: this.iterationLimit,
      });
    } catch (error) {
      this.messages.push(
        this.createMessage(
          "assistant",
          `Ошибка во время работы агента:\n${error.message}`
        )
      );
    } finally {
      this.busy = false;
      this.status = "";
      this.postState();
    }
  }

  async handleContinueRun() {
    if (this.busy || !this.pendingContinuation || this.pendingApproval) {
      return;
    }

    const continuationState = this.pendingContinuation;
    const continuationMessage = this.continuationMessage;
    this.pendingContinuation = undefined;
    this.continuationMessage = "";
    this.busy = true;
    this.status = "Возобновляю агентную сессию...";
    this.postState();

    try {
      await this.runAgentTurn({
        iterationLimit: this.iterationLimit,
        continuationState,
      });
    } catch (error) {
      this.pendingContinuation = continuationState;
      this.continuationMessage = continuationMessage;
      this.messages.push(
        this.createMessage(
          "assistant",
          `Ошибка во время продолжения:\n${error.message}`
        )
      );
    } finally {
      this.busy = false;
      this.status = "";
      this.postState();
    }
  }

  async handlePendingApproval(approved) {
    if (this.busy || !this.pendingApproval) {
      return;
    }

    const approvalState = this.pendingApproval;
    const approvalMessage = this.approvalMessage;
    this.pendingApproval = undefined;
    this.approvalMessage = "";
    this.busy = true;
    this.status = approved
      ? "Применяю подтвержденные изменения..."
      : "Отклоняю предложенные изменения...";
    this.postState();

    try {
      const resolution = approved
        ? await this.runtime.applyPendingChanges()
        : await this.runtime.rejectPendingChanges();

      for (const displayMessage of resolution.displayMessages || []) {
        this.upsertMessage(
          this.createMessage(displayMessage.role || "system", "", displayMessage)
        );
      }

      const systemText = approved
        ? `Пользователь подтвердил и применил ${resolution.count} изменений.`
        : `Пользователь отклонил ${resolution.count} изменений.`;
      this.messages.push(this.createMessage("system", systemText));

      const continuationMessages = [
        ...(approvalState.messages || []),
        {
          role: "system",
          content: approved
            ? `The user approved and applied ${resolution.count} staged file changes.`
            : "The user rejected the staged file changes. No file changes were applied.",
        },
      ];

      const memoryHint = approved ? resolution.memory?.promptHint : "";
      if (memoryHint) {
        continuationMessages.push({
          role: "system",
          content: memoryHint,
        });
      }

      const continuationState = {
        contextPreview: approvalState.contextPreview || this.contextPreview,
        messages: continuationMessages,
      };

      await this.runAgentTurn({
        iterationLimit: this.iterationLimit,
        continuationState,
      });
    } catch (error) {
      this.pendingContinuation = continuationState;
      this.continuationMessage =
        "Прошлый шаг агента завершился ошибкой. Нажмите «Продолжить», чтобы повторить вызов модели на том же контексте.";
      this.messages.push(
        this.createMessage(
          "assistant",
          `Ошибка во время обработки изменений:\n${error.message}`
        )
      );
    } finally {
      this.busy = false;
      this.status = "";
      this.postState();
    }
  }

  async runAgentTurn({ prompt = "", history = [], iterationLimit, continuationState }) {
    const result = await this.runtime.runTurn({
      prompt,
      history,
      iterationLimit,
      continuationState,
      onStatus: (status) => {
        this.status = status;
        this.postState();
      },
      onToolEvent: (event) => {
        this.handleToolEvent(event);
      },
    });

    this.contextPreview = result.contextPreview || this.contextPreview;

    if (result.status === "completed") {
      this.pendingContinuation = undefined;
      this.continuationMessage = "";
      this.pendingApproval = undefined;
      this.approvalMessage = "";
      this.messages.push(this.createMessage("assistant", result.assistantMessage));
      return;
    }

    if (result.status === "needsApproval") {
      this.pendingApproval = result.approvalState;
      this.approvalMessage = result.approvalMessage;
      return;
    }

    if (result.status === "needsContinuation") {
      this.pendingContinuation = result.continuationState;
      this.continuationMessage = result.continuationMessage;
      this.messages.push(this.createMessage("system", result.continuationMessage));
    }
  }

  postInfo(text) {
    this.messages.push(this.createMessage("system", text));
    this.postState();
  }

  handleToolEvent(event) {
    if (event.displayMessage) {
      this.upsertMessage(this.createMessage(event.displayMessage.kind, "", event.displayMessage));
    } else if (event.summary) {
      this.messages.push(this.createMessage("system", event.summary));
    }
    this.postState();
  }

  upsertMessage(message) {
    const index = this.messages.findIndex((item) => item.id === message.id);
    if (index === -1) {
      this.messages.push(message);
      return;
    }

    this.messages[index] = {
      ...this.messages[index],
      ...message,
    };
  }

  createMessage(role, content, extras = {}) {
    return {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      role,
      content,
      ...extras,
    };
  }

  postState() {
    if (!this.view) {
      return;
    }

    this.view.webview.postMessage({
      type: "state",
      payload: {
        busy: this.busy,
        status: this.status,
        contextPreview: this.contextPreview,
        messages: this.messages,
        canContinue: Boolean(this.pendingContinuation),
        continuationMessage: this.continuationMessage,
        canApprove: Boolean(this.pendingApproval),
        approvalMessage: this.approvalMessage,
        iterationLimit: this.iterationLimit,
        modelName: this.modelName,
        baseUrl: this.baseUrl,
        autoApplyChanges: this.autoApplyChanges,
        hasStoredApiKey: this.hasStoredApiKey,
      },
    });
  }

  getConfigurationTarget() {
    return vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  }

  getConfiguredIterationLimit() {
    const configured = vscode.workspace
      .getConfiguration("aiAgentAssistant")
      .get("agent.maxIterations", 8);
    return this.normalizeIterationLimit(configured, 8);
  }

  getConfiguredModelName() {
    return this.openRouterClient.getConfiguredModel();
  }

  getConfiguredBaseUrl() {
    return this.openRouterClient.getConfiguredBaseUrl();
  }

  getConfiguredAutoApplyChanges() {
    return Boolean(
      vscode.workspace
        .getConfiguration("aiAgentAssistant")
        .get("execution.autoApplyFileChanges", false)
    );
  }

  async reloadConfigurationState() {
    this.iterationLimit = this.getConfiguredIterationLimit();
    this.modelName = this.getConfiguredModelName();
    this.baseUrl = this.getConfiguredBaseUrl();
    this.autoApplyChanges = this.getConfiguredAutoApplyChanges();
    this.hasStoredApiKey = await this.openRouterClient.hasStoredApiKey();
    this.postState();
  }

  normalizeSettingsPayload(rawSettings) {
    const settings = rawSettings || {};

    return {
      baseUrl: this.normalizeBaseUrl(settings.baseUrl || this.baseUrl),
      model: String(settings.model || this.modelName).trim(),
      apiKey: String(settings.apiKey || ""),
      clearApiKey: Boolean(settings.clearApiKey),
      iterationLimit: this.normalizeIterationLimit(
        settings.iterationLimit,
        this.iterationLimit
      ),
      autoApplyChanges: Boolean(settings.autoApplyChanges),
    };
  }

  normalizeIterationLimit(value, fallback) {
    const base = Number(value);
    const normalized = Number.isFinite(base) ? base : fallback || 8;
    return Math.max(1, Math.min(100, Math.round(normalized)));
  }

  normalizeBaseUrl(value) {
    const trimmed = String(value || "").trim();
    if (!trimmed) {
      throw new Error("Endpoint не должен быть пустым.");
    }

    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch (_error) {
      throw new Error("Введите корректный URL endpoint.");
    }

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("Endpoint должен использовать http:// или https://");
    }

    return parsed.toString();
  }

  getHtml(webview) {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "styles.css")
    );
    const nonce = getNonce();
    const modelText = escapeHtml(this.modelName);
    const endpointText = escapeHtml(formatEndpointLabel(this.baseUrl));
    const apiKeyText = this.hasStoredApiKey ? "API key сохранен" : "API key не задан";
    const autoApplyChecked = this.autoApplyChanges ? "checked" : "";

    return `<!DOCTYPE html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>AI Agent Assistant</title>
  </head>
  <body>
    <div class="app-shell">
      <header class="hero">
        <div>
          <p class="eyebrow">AI Agent Assistant</p>
          <h1>Контекстный кодовый агент</h1>
          <p class="subtitle">Совместимый chat/completions endpoint + файлы + тесты + действия над проектом</p>
          <div class="hero-meta">
            <div id="currentModel" class="meta-chip">${modelText}</div>
            <div id="currentEndpoint" class="meta-chip meta-chip-secondary">${endpointText}</div>
            <div id="apiKeyStatus" class="meta-chip meta-chip-muted">${apiKeyText}</div>
          </div>
        </div>
        <div class="toolbar">
          <button id="refreshContext" class="ghost">Контекст</button>
          <button id="openSettings" class="ghost">Настройки</button>
          <button id="clearChat" class="ghost">Очистить</button>
        </div>
      </header>

      <section class="context-card">
        <div class="context-label">Что уходит в модель</div>
        <div id="contextPreview" class="context-preview"></div>
      </section>

      <main id="messages" class="messages"></main>

      <footer class="composer">
        <div id="approvalBanner" class="approval-banner" hidden style="display: none !important;">
          <div id="approvalText" class="approval-text"></div>
          <div class="banner-actions">
            <button id="rejectPendingChanges" class="ghost">Отклонить</button>
            <button id="applyPendingChanges" class="primary">Применить</button>
          </div>
        </div>
        <div id="continuationBanner" class="continuation-banner" hidden style="display: none !important;">
          <div id="continuationText" class="continuation-text"></div>
          <button id="continueRun" class="ghost highlight">Продолжить</button>
        </div>
        <label class="composer-label" for="prompt">Запрос к агенту</label>
        <textarea
          id="prompt"
          rows="4"
          placeholder="Например: исправь класс, обнови тесты и прогоняй npm test"
        ></textarea>
        <div class="composer-actions">
          <div id="status" class="status"></div>
          <button id="sendPrompt" class="primary">Отправить</button>
        </div>
      </footer>
    </div>

    <div id="settingsModal" class="settings-backdrop" hidden aria-hidden="true">
      <section class="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
        <div class="settings-header">
          <div>
            <p class="settings-kicker">Настройки</p>
            <h2 id="settingsTitle">Подключение и поведение агента</h2>
            <p class="settings-subtitle">Поддерживаются OpenRouter и другие совместимые chat/completions endpoint.</p>
          </div>
          <button id="closeSettings" type="button" class="icon-button" aria-label="Закрыть настройки">×</button>
        </div>

        <div class="settings-grid">
          <label class="settings-field settings-field-full">
            <span class="settings-label">Endpoint</span>
            <input
              id="settingsBaseUrl"
              class="settings-input"
              type="url"
              value="${escapeAttribute(this.baseUrl)}"
              placeholder="https://openrouter.ai/api/v1/chat/completions"
            />
            <span class="settings-note">Полный URL совместимого endpoint формата chat/completions.</span>
          </label>

          <label class="settings-field">
            <span class="settings-label">Модель</span>
            <input
              id="settingsModel"
              class="settings-input"
              type="text"
              value="${escapeAttribute(this.modelName)}"
              placeholder="openai/gpt-5.2"
            />
          </label>

          <label class="settings-field">
            <span class="settings-label">Лимит итераций</span>
            <input
              id="settingsIterationLimit"
              class="settings-input"
              type="number"
              min="1"
              max="100"
              value="${String(this.iterationLimit)}"
            />
          </label>

          <label class="settings-field settings-field-full">
            <span class="settings-label">API key</span>
            <input
              id="settingsApiKey"
              class="settings-input"
              type="password"
              value=""
              placeholder="${this.hasStoredApiKey ? "Сохранен текущий ключ" : "Необязателен для локальных endpoint"}"
            />
            <span id="settingsApiKeyHint" class="settings-note">${
              this.hasStoredApiKey
                ? "Поле можно оставить пустым, чтобы сохранить текущий ключ."
                : "Если ваш endpoint требует Bearer token, введите ключ здесь."
            }</span>
            <label id="settingsClearApiKeyRow" class="settings-inline-toggle" ${
              this.hasStoredApiKey ? "" : "hidden"
            }>
              <input id="settingsClearApiKey" type="checkbox" />
              <span>Удалить сохраненный API key</span>
            </label>
          </label>

          <label class="settings-toggle settings-field-full">
            <input id="settingsAutoApplyChanges" type="checkbox" ${autoApplyChecked} />
            <div>
              <div class="settings-toggle-title">Автоприменять изменения кода</div>
              <div class="settings-note">Когда включено, diff не показывается и изменения пишутся сразу.</div>
            </div>
          </label>
        </div>

        <div class="settings-actions">
          <button id="cancelSettings" type="button" class="ghost">Отмена</button>
          <button id="saveSettings" type="button" class="primary">Сохранить</button>
        </div>
      </section>
    </div>

    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

function formatEndpointLabel(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    return `${parsed.host}${parsed.pathname}`;
  } catch (_error) {
    return String(baseUrl || "").trim() || "Endpoint не задан";
  }
}

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(text) {
  return escapeHtml(text);
}

function getNonce() {
  return Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join("");
}

module.exports = {
  AssistantViewProvider,
};
