const vscode = require("vscode");
const { AssistantViewProvider } = require("./ui/AssistantViewProvider");
const { ContextCollector } = require("./agent/ContextCollector");
const { OpenRouterClient } = require("./agent/OpenRouterClient");
const { ToolExecutor } = require("./agent/ToolExecutor");
const { AgentRuntime } = require("./agent/AgentRuntime");
const { MemoryManager } = require("./memory/MemoryManager");

function activate(context) {
  const outputChannel = vscode.window.createOutputChannel("AI Agent Assistant");
  const contextCollector = new ContextCollector(outputChannel);
  const openRouterClient = new OpenRouterClient(context.secrets, outputChannel);
  const memoryManager = new MemoryManager(outputChannel);
  const toolExecutor = new ToolExecutor(outputChannel, memoryManager);
  const runtime = new AgentRuntime({
    contextCollector,
    openRouterClient,
    toolExecutor,
    outputChannel,
  });
  const viewProvider = new AssistantViewProvider(context, runtime, openRouterClient);

  context.subscriptions.push(
    outputChannel,
    vscode.window.registerWebviewViewProvider(
      AssistantViewProvider.viewType,
      viewProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }
    ),
    vscode.commands.registerCommand("aiAgentAssistant.focusChat", async () => {
      await viewProvider.focus();
    }),
    vscode.commands.registerCommand("aiAgentAssistant.openSettings", async () => {
      await viewProvider.focus();
      await viewProvider.openSettings();
    }),
    vscode.commands.registerCommand("aiAgentAssistant.clearChat", () => {
      viewProvider.clearChat();
    }),
    vscode.commands.registerCommand("aiAgentAssistant.refreshContext", async () => {
      await viewProvider.refreshContextPreview();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("aiAgentAssistant.agent.maxIterations") ||
        event.affectsConfiguration("aiAgentAssistant.openRouter.model") ||
        event.affectsConfiguration("aiAgentAssistant.openRouter.baseUrl") ||
        event.affectsConfiguration("aiAgentAssistant.execution.autoApplyFileChanges")
      ) {
        viewProvider.reloadConfigurationState();
      }
      if (event.affectsConfiguration("aiAgentAssistant.memory.storagePath")) {
        memoryManager.invalidate();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(async () => {
      await viewProvider.refreshContextPreview();
    }),
    vscode.workspace.onDidSaveTextDocument(async () => {
      await viewProvider.refreshContextPreview();
    })
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
