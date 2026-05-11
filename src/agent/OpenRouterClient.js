const vscode = require("vscode");

const SECRET_KEY = "aiAgentAssistant.openRouter.apiKey";

class OpenRouterClient {
  constructor(secretStorage, outputChannel = null) {
    this.secretStorage = secretStorage;
    this.outputChannel = outputChannel;
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

  logRaw(label, status, raw) {
    if (!this.outputChannel) {
      return;
    }
    this.outputChannel.appendLine(
      `[OpenRouterClient] ${label} (HTTP ${status})`
    );
    if (typeof raw === "string" && raw.length > 0) {
      const snippet = raw.length > 4000 ? `${raw.slice(0, 4000)}\n…[truncated]` : raw;
      this.outputChannel.appendLine(snippet);
    }
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
        this.logRaw("error response", response.status, raw);
        const message = buildErrorMessage({
          status: response.status,
          statusText: response.statusText,
          payload,
          raw,
          model,
          baseUrl,
        });
        throw new Error(message);
      }

      if (!payload) {
        throw new Error("LLM endpoint вернул пустой ответ.");
      }

      const upstreamError = payload?.error || payload?.choices?.[0]?.error;
      if (upstreamError) {
        this.logRaw("upstream error in 200 OK", response.status, raw);
        throw new Error(
          buildErrorMessage({
            status: response.status,
            statusText: response.statusText,
            payload,
            raw,
            model,
            baseUrl,
          })
        );
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

function buildErrorMessage({ status, statusText, payload, raw, model, baseUrl }) {
  const error = payload?.error || payload?.choices?.[0]?.error || {};
  const head =
    error.message ||
    payload?.message ||
    (typeof raw === "string" && raw.length < 200 ? raw : "") ||
    `LLM endpoint returned HTTP ${status}${statusText ? ` ${statusText}` : ""}`;

  const parts = [head];
  const detailParts = [];
  if (status) {
    detailParts.push(`HTTP ${status}${statusText ? ` ${statusText}` : ""}`);
  }
  if (error.code) {
    detailParts.push(`code=${error.code}`);
  }
  if (error.type) {
    detailParts.push(`type=${error.type}`);
  }
  if (model) {
    detailParts.push(`model=${model}`);
  }

  const meta = error.metadata || {};
  const metaParts = [];
  if (meta.provider_name || meta.provider) {
    metaParts.push(`provider=${meta.provider_name || meta.provider}`);
  }
  if (meta.reason) {
    metaParts.push(`reason=${meta.reason}`);
  }
  if (typeof meta.raw === "string" && meta.raw.trim()) {
    const trimmed = meta.raw.trim();
    metaParts.push(
      `raw=${trimmed.length > 240 ? `${trimmed.slice(0, 240)}…` : trimmed}`
    );
  } else if (meta.raw && typeof meta.raw === "object") {
    const stringified = safeStringify(meta.raw);
    metaParts.push(
      `raw=${stringified.length > 240 ? `${stringified.slice(0, 240)}…` : stringified}`
    );
  }

  if (detailParts.length) {
    parts.push(`(${detailParts.join(", ")})`);
  }
  if (metaParts.length) {
    parts.push(metaParts.join(" • "));
  }

  if (!error.message && !payload?.message && raw && raw.length >= 200) {
    parts.push(
      `Полный ответ виден в Output → AI Agent Assistant. Endpoint: ${baseUrl}`
    );
  }

  return parts.join(" ");
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

module.exports = {
  OpenRouterClient,
  buildErrorMessage,
};
