const vscode = require("vscode");

const SECRET_KEY = "aiAgentAssistant.openRouter.apiKey";

class OpenRouterClient {
  constructor(secretStorage) {
    this.secretStorage = secretStorage;
  }

  async getApiKey() {
    return (
      (await this.secretStorage.get(SECRET_KEY)) ||
      process.env.OPENROUTER_API_KEY ||
      ""
    );
  }

  async hasStoredApiKey() {
    return Boolean(await this.getApiKey());
  }

  async storeApiKey(apiKey) {
    const normalized = String(apiKey || "").trim();
    if (!normalized) {
      return false;
    }

    await this.secretStorage.store(SECRET_KEY, normalized);
    return true;
  }

  async clearApiKey() {
    await this.secretStorage.delete(SECRET_KEY);
  }

  getConfiguredModel() {
    return vscode.workspace
      .getConfiguration("aiAgentAssistant")
      .get("openRouter.model", "openai/gpt-5.2");
  }

  getConfiguredBaseUrl() {
    return vscode.workspace
      .getConfiguration("aiAgentAssistant")
      .get("openRouter.baseUrl", "https://openrouter.ai/api/v1/chat/completions");
  }

  async saveConnectionSettings({ apiKey, model, baseUrl, clearApiKey }) {
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;

    const normalizedModel = String(model || "").trim();
    const normalizedBaseUrl = String(baseUrl || "").trim();

    if (!normalizedModel) {
      throw new Error("Модель не должна быть пустой.");
    }

    if (!normalizedBaseUrl) {
      throw new Error("Endpoint не должен быть пустым.");
    }

    await vscode.workspace
      .getConfiguration("aiAgentAssistant")
      .update("openRouter.model", normalizedModel, target);

    await vscode.workspace
      .getConfiguration("aiAgentAssistant")
      .update("openRouter.baseUrl", normalizedBaseUrl, target);

    if (clearApiKey) {
      await this.clearApiKey();
    }

    if (String(apiKey || "").trim()) {
      await this.storeApiKey(apiKey);
    }

    return {
      model: normalizedModel,
      baseUrl: normalizedBaseUrl,
      hasStoredApiKey: await this.hasStoredApiKey(),
    };
  }

  async createChatCompletion({ messages, tools }) {
    const apiKey = await this.getApiKey();
    if (typeof fetch !== "function") {
      throw new Error("Глобальный fetch недоступен в extension host.");
    }

    const config = vscode.workspace.getConfiguration("aiAgentAssistant");
    const model = this.getConfiguredModel();
    const baseUrl = this.getConfiguredBaseUrl();
    const timeoutMs = Number(config.get("openRouter.requestTimeoutMs", 120000));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers = {
        "Content-Type": "application/json",
      };

      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }

      if (isOpenRouterBaseUrl(baseUrl)) {
        if (!apiKey) {
          throw new Error(
            "Для OpenRouter не найден API key. Откройте настройки ассистента и сохраните ключ."
          );
        }

        headers["X-OpenRouter-Title"] = "VS Code AI Agent Assistant";
      }

      const response = await fetch(baseUrl, {
        method: "POST",
        signal: controller.signal,
        headers,
        body: JSON.stringify({
          model,
          messages,
          tools,
          tool_choice: "auto",
          temperature: 0.1,
          stream: false,
        }),
      });

      const raw = await response.text();
      const payload = raw ? tryParseJson(raw) : undefined;

      if (!response.ok) {
        const message =
          payload?.error?.message ||
          payload?.message ||
          raw ||
          `LLM endpoint returned HTTP ${response.status}`;
        throw new Error(message);
      }

      if (!payload) {
        throw new Error("LLM endpoint вернул пустой ответ.");
      }

      return payload;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`Запрос к LLM endpoint превысил timeout ${timeoutMs} мс.`);
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function tryParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return undefined;
  }
}

function isOpenRouterBaseUrl(baseUrl) {
  try {
    return new URL(baseUrl).hostname === "openrouter.ai";
  } catch (_error) {
    return String(baseUrl || "").includes("openrouter.ai");
  }
}

module.exports = {
  OpenRouterClient,
};
