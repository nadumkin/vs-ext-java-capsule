const path = require("path");
const fs = require("fs/promises");
const { execFile } = require("child_process");
let vscode = null;
try {
  vscode = require("vscode");
} catch (_error) {
  vscode = null;
}

const NGRAM_SIZE = 3;
const MAX_OPCODES_PER_METHOD = 600;
const MAX_NGRAMS_TOTAL = 400;
const JAVAP_TIMEOUT_MS = 8000;

const DEFAULT_CLASS_OUTPUT_DIRS = [
  "target/classes",
  "target/test-classes",
  "build/classes/java/main",
  "build/classes/java/test",
  "build/classes/kotlin/main",
  "out/production/classes",
  "out/test/classes",
  "bin/main",
  "bin/test",
  "bin",
];

class BytecodeFingerprint {
  constructor(outputChannel) {
    this.outputChannel = outputChannel;
    this.javapAvailable = null;
  }

  async build({ affectedMethods }) {
    if (!affectedMethods?.length) {
      return null;
    }
    if (!vscode) {
      return null;
    }
    const mode = this.getMode();
    if (mode === "off") {
      return null;
    }

    const haveJavap = await this.checkJavapAvailable();
    if (!haveJavap) {
      if (mode === "force") {
        this.outputChannel?.appendLine(
          "[memory] javap not found in PATH, but bytecodeProbe=force; skipping fingerprint."
        );
      }
      return null;
    }

    const ownerNames = new Set(
      affectedMethods.map((method) => method.ownerFqn).filter(Boolean)
    );
    const interestingMethodNames = new Set(
      affectedMethods.map((method) => method.name).filter(Boolean)
    );

    const ngrams = new Set();
    for (const ownerFqn of ownerNames) {
      const classFile = await this.findClassFile(ownerFqn);
      if (!classFile) {
        continue;
      }
      try {
        const javapOut = await this.runJavap(classFile);
        const methods = parseJavapOutput(javapOut);
        for (const method of methods) {
          if (interestingMethodNames.size > 0 && !interestingMethodNames.has(method.name)) {
            continue;
          }
          const opcodes = method.opcodes.slice(0, MAX_OPCODES_PER_METHOD);
          for (const ngram of buildNgrams(opcodes, NGRAM_SIZE)) {
            ngrams.add(ngram);
            if (ngrams.size >= MAX_NGRAMS_TOTAL) {
              return { ngrams: [...ngrams] };
            }
          }
        }
      } catch (error) {
        this.outputChannel?.appendLine(
          `[memory] javap on ${classFile} failed: ${error?.message || error}`
        );
      }
    }

    if (ngrams.size === 0) {
      return null;
    }
    return { ngrams: [...ngrams] };
  }

  getMode() {
    const value = String(
      vscode.workspace
        .getConfiguration("aiAgentAssistant")
        .get("memory.java.bytecodeProbe", "auto") || "auto"
    ).toLowerCase();
    if (value === "off" || value === "force" || value === "auto") {
      return value;
    }
    return "auto";
  }

  getConfiguredOutputDirs() {
    const raw = vscode.workspace
      .getConfiguration("aiAgentAssistant")
      .get("memory.java.classOutputPaths", []);
    if (Array.isArray(raw) && raw.length > 0) {
      return raw.map((value) => String(value));
    }
    return DEFAULT_CLASS_OUTPUT_DIRS;
  }

  async checkJavapAvailable() {
    if (this.javapAvailable !== null) {
      return this.javapAvailable;
    }
    try {
      await execFileAsync("javap", ["-version"], { timeout: 4000 });
      this.javapAvailable = true;
    } catch (_error) {
      this.javapAvailable = false;
    }
    return this.javapAvailable;
  }

  async findClassFile(ownerFqn) {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      return null;
    }
    const relative = `${ownerFqn.replace(/\./g, "/")}.class`;
    const dirs = this.getConfiguredOutputDirs();

    for (const dir of dirs) {
      const candidate = path.join(workspace.uri.fsPath, dir, relative);
      if (await fileExists(candidate)) {
        return candidate;
      }
    }

    const lastSegment = relative.split("/").pop();
    if (!lastSegment) {
      return null;
    }
    try {
      const matches = await vscode.workspace.findFiles(
        `**/${lastSegment}`,
        "**/{node_modules,.git}/**",
        20
      );
      const target = ownerFqn.replace(/\./g, "/") + ".class";
      for (const uri of matches) {
        const normalized = uri.fsPath.replace(/\\/g, "/");
        if (normalized.endsWith(target)) {
          return uri.fsPath;
        }
      }
    } catch (_error) {
      return null;
    }
    return null;
  }

  async runJavap(classFile) {
    const result = await execFileAsync(
      "javap",
      ["-c", "-p", "-constants", classFile],
      { timeout: JAVAP_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }
    );
    return result.stdout || "";
  }
}

function parseJavapOutput(text) {
  const lines = String(text || "").split(/\r?\n/);
  const methods = [];
  let current = null;
  let inCode = false;

  const declRe =
    /^\s*(?:(?:public|protected|private|static|final|abstract|synchronized|default|native|strictfp)\s+)*(?:[\w$.<>?\[\]]+\s+)?([\w$<>.]+)\(([^)]*)\)\s*(?:throws\s+[\w\s.,$]+)?\s*;\s*$/;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\/\/.*$/, "");
    if (!inCode) {
      const match = rawLine.match(declRe);
      if (match) {
        if (current) {
          methods.push(current);
        }
        current = {
          name: match[1].replace(/^[\w$.]*\.([\w$<>]+)$/, "$1"),
          paramText: match[2],
          opcodes: [],
        };
        continue;
      }
      if (/^\s*Code:\s*$/.test(line)) {
        inCode = true;
      }
      continue;
    }

    if (line.trim() === "") {
      inCode = false;
      continue;
    }

    const opMatch = line.match(/^\s*\d+:\s+([a-z][\w_]*)/);
    if (opMatch && current) {
      current.opcodes.push(normalizeOpcode(opMatch[1]));
    }
  }

  if (current) {
    methods.push(current);
  }

  return methods;
}

function normalizeOpcode(op) {
  return op
    .replace(/_(\d+)$/, "")
    .replace(/_(m1|null)$/, "");
}

function buildNgrams(opcodes, n) {
  const out = [];
  if (!Array.isArray(opcodes) || opcodes.length < n) {
    return out;
  }
  for (let i = 0; i + n <= opcodes.length; i++) {
    out.push(opcodes.slice(i, i + n).join(" "));
  }
  return out;
}

function execFileAsync(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch (_error) {
    return false;
  }
}

module.exports = {
  BytecodeFingerprint,
  parseJavapOutput,
  buildNgrams,
};
