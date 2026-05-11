const path = require("path");
let vscode = null;
try {
  vscode = require("vscode");
} catch (_error) {
  vscode = null;
}

const {
  JavaSourceParser,
  offsetToLine,
  findEnclosingMethod,
} = require("./JavaSourceParser");

const CALL_RE = /\b([A-Za-z_]\w*)\s*\(/g;
const CALLEE_STOPWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "synchronized",
  "try",
  "do",
  "return",
  "new",
  "throw",
  "assert",
  "case",
  "super",
  "this",
]);

const DEFAULT_EXCLUDE =
  "**/{node_modules,.git,dist,out,build,coverage,.next,target,vendor,.gradle,.idea}/**";
const MAX_CALLER_FILES = 200;
const MAX_CALLERS = 50;
const MAX_CALLEES = 50;

class JavaEnricher {
  constructor(outputChannel) {
    this.outputChannel = outputChannel;
    this.parser = new JavaSourceParser();
    this.decoder = new TextDecoder("utf-8");
  }

  isJavaPath(filePath) {
    return path.extname(String(filePath || "")).toLowerCase() === ".java";
  }

  isAvailable() {
    return Boolean(vscode);
  }

  async enrichChanges(changes) {
    const javaChanges = (changes || []).filter((change) =>
      this.isJavaPath(change.path)
    );

    if (javaChanges.length === 0) {
      return {
        affectedMethods: [],
        callers: [],
        callees: [],
        primaryFiles: [],
      };
    }

    const affected = new Map();
    const callees = new Set();
    const primaryFiles = [];

    for (const change of javaChanges) {
      primaryFiles.push(change.path);
      const proposedParsed = this.parser.parse(change.proposedContent || "");
      const originalParsed = this.parser.parse(change.originalContent || "");

      const proposedHits = collectChangedLineMethods({
        parsed: proposedParsed,
        source: change.proposedContent || "",
        comparedSource: change.originalContent || "",
      });
      const originalHits = collectChangedLineMethods({
        parsed: originalParsed,
        source: change.originalContent || "",
        comparedSource: change.proposedContent || "",
      });

      for (const method of [...proposedHits, ...originalHits]) {
        if (!method) {
          continue;
        }
        if (!affected.has(method.fqn)) {
          affected.set(method.fqn, method);
        }
        for (const callee of extractCallees(method.bodyText, method.name)) {
          callees.add(callee);
        }
      }
    }

    const callers = await this.findCallersInWorkspace({
      affectedMethods: [...affected.values()],
      excludeFiles: javaChanges.map((change) => change.path),
    });

    return {
      affectedMethods: [...affected.values()].map((method) => ({
        fqn: method.fqn,
        signature: method.signature,
        ownerFqn: method.ownerFqn,
        name: method.name,
      })),
      callers: cap(callers, MAX_CALLERS),
      callees: cap([...callees], MAX_CALLEES),
      primaryFiles,
    };
  }

  async findCallersInWorkspace({ affectedMethods, excludeFiles }) {
    if (!vscode || affectedMethods.length === 0) {
      return [];
    }

    const interestingNames = new Set();
    for (const method of affectedMethods) {
      if (!method.name) {
        continue;
      }
      if (method.name.length < 3) {
        continue;
      }
      interestingNames.add(method.name);
    }
    if (interestingNames.size === 0) {
      return [];
    }

    const excludeSet = new Set((excludeFiles || []).map((p) => normalizePath(p)));
    const callers = new Set();

    let files;
    try {
      files = await vscode.workspace.findFiles(
        "**/*.java",
        DEFAULT_EXCLUDE,
        MAX_CALLER_FILES
      );
    } catch (error) {
      this.outputChannel?.appendLine(
        `[memory] findFiles failed: ${error?.message || error}`
      );
      return [];
    }

    for (const uri of files) {
      const relative = vscode.workspace.asRelativePath(uri, false);
      if (excludeSet.has(normalizePath(relative))) {
        continue;
      }

      let text;
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        text = this.decoder.decode(bytes);
      } catch (_error) {
        continue;
      }

      let parsed;
      try {
        parsed = this.parser.parse(text);
      } catch (_error) {
        continue;
      }

      for (const type of parsed.types) {
        for (const method of type.methods) {
          for (const calleeName of extractCallees(method.bodyText, method.name)) {
            if (interestingNames.has(calleeName)) {
              callers.add(method.fqn);
              if (callers.size >= MAX_CALLERS * 2) {
                return [...callers];
              }
            }
          }
        }
      }
    }

    return [...callers];
  }
}

function collectChangedLineMethods({ parsed, source, comparedSource }) {
  const sourceLines = String(source).split(/\r?\n/);
  const comparedCounts = new Map();
  for (const line of String(comparedSource).split(/\r?\n/)) {
    comparedCounts.set(line, (comparedCounts.get(line) || 0) + 1);
  }

  const changedLineNumbers = [];
  for (let index = 0; index < sourceLines.length; index++) {
    const line = sourceLines[index];
    const count = comparedCounts.get(line) || 0;
    if (count > 0) {
      comparedCounts.set(line, count - 1);
      continue;
    }
    if (line.trim().length === 0) {
      continue;
    }
    changedLineNumbers.push(index + 1);
  }

  const seen = new Set();
  const result = [];
  for (const lineNumber of changedLineNumbers) {
    const enclosing = findEnclosingMethod(parsed, source, lineNumber);
    if (!enclosing) {
      continue;
    }
    if (seen.has(enclosing.method.fqn)) {
      continue;
    }
    seen.add(enclosing.method.fqn);
    result.push(enclosing.method);
  }
  return result;
}

function extractCallees(bodyText, ownName) {
  const collected = new Set();
  if (!bodyText) {
    return collected;
  }
  CALL_RE.lastIndex = 0;
  let match;
  while ((match = CALL_RE.exec(bodyText)) !== null) {
    const name = match[1];
    if (name === ownName) {
      continue;
    }
    if (CALLEE_STOPWORDS.has(name)) {
      continue;
    }
    if (name.length < 2) {
      continue;
    }
    collected.add(name);
  }
  return collected;
}

function cap(values, limit) {
  if (!Array.isArray(values)) {
    return [];
  }
  if (values.length <= limit) {
    return values.slice();
  }
  return values.slice(0, limit);
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/");
}

module.exports = {
  JavaEnricher,
};
