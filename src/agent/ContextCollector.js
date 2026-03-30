const vscode = require("vscode");
const path = require("path");

const DEFAULT_EXCLUDE =
  "**/{node_modules,.git,dist,out,build,coverage,.next,target,vendor}/**";
const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".py",
  ".java",
  ".kt",
  ".kts",
  ".cs",
  ".go",
  ".rb",
  ".php",
];
const MAX_SCAN_FILE_BYTES = 512 * 1024;

class ContextCollector {
  constructor(outputChannel) {
    this.outputChannel = outputChannel;
    this.decoder = new TextDecoder("utf-8");
  }

  async previewContext() {
    const context = await this.collectContext("");
    return {
      summaryText: this.buildSummaryText(context),
    };
  }

  async collectContext(userPrompt) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      throw new Error("Откройте файл в редакторе, чтобы собрать контекст.");
    }

    const document = editor.document;
    const config = vscode.workspace.getConfiguration("aiAgentAssistant");
    const maxImportedFiles = Number(config.get("context.maxImportedFiles", 8));
    const maxTests = Number(config.get("context.maxTests", 6));
    const maxFileChars = Number(config.get("context.maxFileChars", 16000));
    const workspaceFolder =
      vscode.workspace.getWorkspaceFolder(document.uri) ||
      vscode.workspace.workspaceFolders?.[0];

    const activeFile = this.readDocumentSnapshot(document, maxFileChars);
    const className = this.detectPrimaryClassName(
      document.getText(),
      path.basename(document.fileName, path.extname(document.fileName))
    );
    const importRefs = this.parseImports(document.languageId, document.getText());
    const imports = await this.resolveImportedFiles({
      document,
      importRefs,
      workspaceFolder,
      maxImportedFiles,
      maxFileChars,
    });
    const tests = await this.findRelatedTests({
      document,
      workspaceFolder,
      className,
      maxTests,
      maxFileChars,
    });
    const selection = this.getSelectionSnapshot(editor, maxFileChars);

    const context = {
      workspaceFolderPath: workspaceFolder?.uri.fsPath || "",
      className,
      activeFile,
      imports,
      tests,
      selection,
      userPrompt: String(userPrompt || "").trim(),
    };

    return {
      ...context,
      promptText: this.renderPrompt(context),
      summaryText: this.buildSummaryText(context),
    };
  }

  buildSummaryText(context) {
    const parts = [
      `Файл: ${context.activeFile.path}`,
      `Класс: ${context.className || "не найден"}`,
      `Импорты: ${context.imports.length}`,
      `Тесты: ${context.tests.length}`,
    ];

    if (context.selection) {
      parts.push("Есть выделение");
    }

    return parts.join(" • ");
  }

  readDocumentSnapshot(document, maxChars) {
    return {
      path: this.toWorkspacePath(document.uri),
      languageId: document.languageId,
      ...truncateText(document.getText(), maxChars),
    };
  }

  getSelectionSnapshot(editor, maxChars) {
    if (editor.selection.isEmpty) {
      return null;
    }

    const selectedText = editor.document.getText(editor.selection);
    if (!selectedText.trim()) {
      return null;
    }

    return {
      startLine: editor.selection.start.line + 1,
      endLine: editor.selection.end.line + 1,
      ...truncateText(selectedText, maxChars),
    };
  }

  detectPrimaryClassName(text, fallbackStem) {
    const patterns = [
      /\bexport\s+default\s+class\s+([A-Za-z_][\w$]*)/,
      /\b(?:export\s+)?class\s+([A-Za-z_][\w$]*)/,
      /\bclass\s+([A-Za-z_][\w$]*)\s*(?:\(|:|{)/,
      /\b(?:public|internal|private|protected)?\s*(?:abstract\s+|sealed\s+)?class\s+([A-Za-z_][\w$]*)/,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }

    return fallbackStem || "";
  }

  parseImports(languageId, text) {
    const refs = [];
    const seen = new Set();
    const pushRef = (specifier, importedNames = []) => {
      if (!specifier || seen.has(specifier)) {
        return;
      }

      refs.push({
        specifier,
        importedNames,
      });
      seen.add(specifier);
    };

    if (
      ["javascript", "javascriptreact", "typescript", "typescriptreact"].includes(
        languageId
      )
    ) {
      for (const match of text.matchAll(
        /^\s*import\s+(.+?)\s+from\s+['"]([^'"]+)['"]/gm
      )) {
        pushRef(match[2], extractImportedNames(match[1]));
      }

      for (const match of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/gm)) {
        pushRef(match[1], []);
      }
    }

    if (languageId === "python") {
      for (const match of text.matchAll(/^\s*from\s+([.\w]+)\s+import\s+(.+)$/gm)) {
        pushRef(match[1], extractImportedNames(match[2]));
      }
    }

    if (["java", "kotlin", "csharp", "php"].includes(languageId)) {
      for (const match of text.matchAll(/^\s*(?:import|using|use)\s+([\w.\\]+)\s*;?/gm)) {
        const specifier = match[1];
        const importedNames = [specifier.split(/[.\\]/).pop()].filter(Boolean);
        pushRef(specifier, importedNames);
      }
    }

    return refs;
  }

  async resolveImportedFiles({
    document,
    importRefs,
    workspaceFolder,
    maxImportedFiles,
    maxFileChars,
  }) {
    const collected = [];
    const seen = new Set([document.uri.fsPath]);

    for (const ref of importRefs.slice(0, maxImportedFiles * 4)) {
      const candidates = await this.resolveImportReference(
        ref,
        document.uri,
        workspaceFolder
      );

      for (const candidate of candidates) {
        if (!candidate?.fsPath || seen.has(candidate.fsPath)) {
          continue;
        }

        seen.add(candidate.fsPath);
        const snapshot = await this.readUriSnapshot(candidate, maxFileChars);
        if (!snapshot) {
          continue;
        }

        collected.push(snapshot);
        if (collected.length >= maxImportedFiles) {
          return collected;
        }
      }
    }

    return collected;
  }

  async resolveImportReference(ref, documentUri, workspaceFolder) {
    const specifier = ref.specifier.trim();
    const candidates = [];

    if (
      specifier.startsWith(".") ||
      specifier.startsWith("/") ||
      specifier.startsWith("@/") ||
      specifier.startsWith("~/")
    ) {
      const pathCandidates = this.getPathCandidates(
        specifier,
        documentUri,
        workspaceFolder
      );

      for (const fsPath of pathCandidates) {
        const uri = vscode.Uri.file(fsPath);
        if (await this.isFile(uri)) {
          candidates.push(uri);
        }
      }
    }

    if (candidates.length > 0) {
      return dedupeUris(candidates);
    }

    const stems = new Set();
    const lastSegment = specifier.split(/[\\/]/).pop();
    if (lastSegment) {
      stems.add(lastSegment);
    }

    for (const name of ref.importedNames || []) {
      if (name) {
        stems.add(name);
      }
    }

    const found = [];
    for (const stem of stems) {
      const matches = await vscode.workspace.findFiles(
        `**/${sanitizeStem(stem)}.*`,
        DEFAULT_EXCLUDE,
        10
      );
      for (const uri of matches) {
        if (!isProbablySourceFile(uri.fsPath)) {
          continue;
        }
        found.push(uri);
      }
      if (found.length >= 5) {
        break;
      }
    }

    return dedupeUris(found).sort((left, right) =>
      scoreSourceUri(right.fsPath) - scoreSourceUri(left.fsPath)
    );
  }

  getPathCandidates(specifier, documentUri, workspaceFolder) {
    const bases = [];
    const currentDir = path.dirname(documentUri.fsPath);
    const workspaceRoot = workspaceFolder?.uri.fsPath;

    if (specifier.startsWith(".")) {
      bases.push(path.resolve(currentDir, specifier));
    } else if (specifier.startsWith("@/") || specifier.startsWith("~/")) {
      if (workspaceRoot) {
        bases.push(path.join(workspaceRoot, specifier.slice(2)));
      }
    } else if (specifier.startsWith("/")) {
      if (workspaceRoot) {
        bases.push(path.join(workspaceRoot, specifier.slice(1)));
      }
    } else if (workspaceRoot) {
      bases.push(path.join(workspaceRoot, specifier));
      bases.push(path.join(workspaceRoot, "src", specifier));
    }

    const paths = [];
    for (const base of bases) {
      if (path.extname(base)) {
        paths.push(base);
        continue;
      }

      paths.push(base);
      for (const extension of SOURCE_EXTENSIONS) {
        paths.push(`${base}${extension}`);
        paths.push(path.join(base, `index${extension}`));
      }
    }

    return [...new Set(paths)];
  }

  async findRelatedTests({
    document,
    workspaceFolder,
    className,
    maxTests,
    maxFileChars,
  }) {
    const basename = path.basename(document.fileName, path.extname(document.fileName));
    const scoreMap = new Map();
    const directPatterns = [
      `**/${sanitizeStem(basename)}.test.*`,
      `**/${sanitizeStem(basename)}.spec.*`,
      `**/${sanitizeStem(basename)}Test.*`,
      `**/${sanitizeStem(basename)}Spec.*`,
    ];

    if (className && className !== basename) {
      directPatterns.push(`**/${sanitizeStem(className)}.test.*`);
      directPatterns.push(`**/${sanitizeStem(className)}.spec.*`);
      directPatterns.push(`**/${sanitizeStem(className)}Test.*`);
      directPatterns.push(`**/${sanitizeStem(className)}Spec.*`);
    }

    for (const pattern of directPatterns) {
      const matches = await vscode.workspace.findFiles(pattern, DEFAULT_EXCLUDE, 12);
      for (const uri of matches) {
        this.bumpScore(scoreMap, uri, 25, "direct-pattern");
      }
    }

    const searchTerms = [basename];
    if (className && className !== basename) {
      searchTerms.unshift(className);
    }

    const candidateTestFiles = await this.findCandidateTestFiles();
    for (const term of searchTerms) {
      const normalizedTerm = term.toLowerCase();
      for (const uri of candidateTestFiles) {
        const content = await this.readUriText(uri);
        if (content && content.toLowerCase().includes(normalizedTerm)) {
          this.bumpScore(scoreMap, uri, 10, "text-hit");
        }
      }
    }

    if (workspaceFolder) {
      const siblingDir = path.dirname(document.uri.fsPath);
      const siblingCandidates = candidateTestFiles;
      for (const uri of siblingCandidates) {
        if (!isProbablyTestFile(uri.fsPath)) {
          continue;
        }
        if (path.dirname(uri.fsPath) === siblingDir) {
          this.bumpScore(scoreMap, uri, 4, "same-dir");
        }
      }
    }

    const ranked = [...scoreMap.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, maxTests);

    const snapshots = [];
    for (const item of ranked) {
      const snapshot = await this.readUriSnapshot(item.uri, maxFileChars);
      if (snapshot) {
        snapshots.push(snapshot);
      }
    }

    return snapshots;
  }

  bumpScore(scoreMap, uri, score, reason) {
    const key = uri.fsPath;
    const existing = scoreMap.get(key) || {
      uri,
      score: 0,
      reasons: [],
    };
    existing.score += score;
    existing.reasons.push(reason);
    scoreMap.set(key, existing);
  }

  async findCandidateTestFiles() {
    return dedupeUris([
      ...(await vscode.workspace.findFiles("**/*.test.*", DEFAULT_EXCLUDE, 60)),
      ...(await vscode.workspace.findFiles("**/*.spec.*", DEFAULT_EXCLUDE, 60)),
      ...(await vscode.workspace.findFiles("**/*Test.*", DEFAULT_EXCLUDE, 40)),
      ...(await vscode.workspace.findFiles("**/*Spec.*", DEFAULT_EXCLUDE, 40)),
      ...(await vscode.workspace.findFiles("**/__tests__/**", DEFAULT_EXCLUDE, 40)),
      ...(await vscode.workspace.findFiles("**/tests/**", DEFAULT_EXCLUDE, 40)),
      ...(await vscode.workspace.findFiles("**/test/**", DEFAULT_EXCLUDE, 40)),
    ]).filter((uri) => isProbablyTestFile(uri.fsPath));
  }

  async readUriSnapshot(uri, maxChars) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const decoded = this.decoder.decode(bytes);
      return {
        path: this.toWorkspacePath(uri),
        languageId: guessLanguageId(uri.fsPath),
        ...truncateText(decoded, maxChars),
      };
    } catch (_error) {
      return null;
    }
  }

  async readUriText(uri) {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_SCAN_FILE_BYTES) {
        return "";
      }

      const bytes = await vscode.workspace.fs.readFile(uri);
      return this.decoder.decode(bytes);
    } catch (_error) {
      return "";
    }
  }

  toWorkspacePath(uri) {
    return vscode.workspace.asRelativePath(uri, false) || uri.fsPath;
  }

  async isFile(uri) {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      return stat.type === vscode.FileType.File;
    } catch (_error) {
      return false;
    }
  }

  renderPrompt(context) {
    const sections = [
      "You are a coding agent inside VS Code. Work in the user's language when possible.",
      context.userPrompt
        ? `User request:\n${context.userPrompt}`
        : "User request:\nNo additional request was provided. Analyze the context and take the most useful next step.",
      [
        "Workspace snapshot:",
        `- Workspace root: ${context.workspaceFolderPath || "unknown"}`,
        `- Active file: ${context.activeFile.path}`,
        `- Primary class: ${context.className || "not detected"}`,
        `- Imported files included: ${context.imports.length}`,
        `- Related tests included: ${context.tests.length}`,
      ].join("\n"),
      this.renderFileSection("Active file", context.activeFile),
    ];

    if (context.selection) {
      sections.push(
        [
          "## Current selection",
          `Lines: ${context.selection.startLine}-${context.selection.endLine}`,
          context.selection.truncated
            ? "Selection content was truncated."
            : "Selection content:",
          fenceBlock("", context.selection.content),
        ].join("\n")
      );
    }

    if (context.imports.length > 0) {
      sections.push(
        [
          "## Imported files",
          ...context.imports.map((file) =>
            this.renderFileSection(`Imported file: ${file.path}`, file)
          ),
        ].join("\n\n")
      );
    } else {
      sections.push("## Imported files\nNo local imported files were resolved.");
    }

    if (context.tests.length > 0) {
      sections.push(
        [
          "## Related tests",
          ...context.tests.map((file) =>
            this.renderFileSection(`Test file: ${file.path}`, file)
          ),
        ].join("\n\n")
      );
    } else {
      sections.push("## Related tests\nNo related tests were found.");
    }

    sections.push(
      "Use tools whenever you need to inspect more files, modify the project, or run commands. Prefer actual tool use over describing intended edits."
    );

    return sections.join("\n\n");
  }

  renderFileSection(title, file) {
    const metadata = [
      `## ${title}`,
      `Path: ${file.path}`,
      `Language: ${file.languageId || "plaintext"}`,
    ];

    if (file.truncated) {
      metadata.push("Content was truncated to fit the prompt budget.");
    }

    metadata.push(fenceBlock(file.languageId || "", file.content));
    return metadata.join("\n");
  }
}

function extractImportedNames(raw) {
  return String(raw)
    .replace(/[{}*]/g, " ")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter((item) => item && item !== "from" && item !== "as");
}

function sanitizeStem(stem) {
  return String(stem).replace(/[^\w.-]/g, "");
}

function scoreSourceUri(fsPath) {
  let score = 0;
  if (isProbablySourceFile(fsPath)) {
    score += 3;
  }
  if (!isProbablyTestFile(fsPath)) {
    score += 2;
  }
  if (/\.(ts|tsx|js|jsx|py|java|cs)$/.test(fsPath)) {
    score += 2;
  }
  return score;
}

function isProbablySourceFile(fsPath) {
  const extension = path.extname(fsPath).toLowerCase();
  return SOURCE_EXTENSIONS.includes(extension) && !isProbablyTestFile(fsPath);
}

function isProbablyTestFile(fsPath) {
  return /(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\./i.test(fsPath);
}

function dedupeUris(uris) {
  const seen = new Set();
  return uris.filter((uri) => {
    if (!uri?.fsPath || seen.has(uri.fsPath)) {
      return false;
    }
    seen.add(uri.fsPath);
    return true;
  });
}

function fenceBlock(languageId, content) {
  return `\`\`\`${languageId}\n${content}\n\`\`\``;
}

function truncateText(text, maxChars) {
  if (text.length <= maxChars) {
    return {
      content: text,
      truncated: false,
    };
  }

  return {
    content: `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`,
    truncated: true,
  };
}

function guessLanguageId(fsPath) {
  const extension = path.extname(fsPath).toLowerCase();
  const map = {
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".py": "python",
    ".java": "java",
    ".cs": "csharp",
    ".php": "php",
    ".go": "go",
    ".rb": "ruby",
  };
  return map[extension] || "plaintext";
}

module.exports = {
  ContextCollector,
};
