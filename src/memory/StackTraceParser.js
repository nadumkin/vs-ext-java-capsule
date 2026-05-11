const TEST_COMMAND_RE =
  /(?:^|[\s&;])\s*(?:mvn(?:w)?\s+(?:test|verify|compile|package|install|surefire:test|failsafe:test)|\.?\/?gradlew?\s+(?:test|check|build|compileJava)|gradle\s+(?:test|check|build|compileJava)|javac\b|npx?\s+(?:jest|mocha|vitest|ava|playwright|tsc)|tsc\b|jest|mocha|vitest|pytest|py\.test|go\s+(?:test|build)|cargo\s+(?:test|build|check)|dotnet\s+(?:test|build)|rspec|bundle\s+exec\s+rspec|npm\s+(?:test|run\s+(?:test|build))|yarn\s+(?:test|run\s+(?:test|build))|pnpm\s+(?:test|run\s+(?:test|build)))\b/i;

const TEST_OUTPUT_HINTS = [
  "Tests run:",
  "BUILD FAILURE",
  "BUILD SUCCESS",
  "=== FAILURES ===",
  "test session starts",
  "passed,",
  "failed,",
  "FAILED",
  "OK (",
  "JUnit Jupiter",
  "COMPILATION ERROR",
  "COMPILATION WARNING",
  "[ERROR]",
];

const EXCEPTION_LINE_RE =
  /^\s*(?:Caused by:\s*)?((?:[a-zA-Z_][\w]*\.)*[A-Z][\w]*(?:Exception|Error|AssertionError|Failure))(?::\s*(.+))?\s*$/;
const JAVA_FRAME_RE =
  /^\s*at\s+([\w$.]+)\.([\w$<>]+)\(([^)]+)\)\s*$/;
const PYTEST_EXCEPTION_RE =
  /^E\s+((?:[a-zA-Z_][\w]*\.)*[A-Z][\w]*(?:Error|Exception|Failure)):?\s*(.*)$/;
const MAVEN_COMPILE_ERROR_RE =
  /^\s*\[ERROR\]\s+(.+?\.java):\[(\d+)(?:,(\d+))?\]\s+(.+?)\s*$/;
const JAVAC_DIAGNOSTIC_RE =
  /^\s*(.+?\.java):(\d+):\s*(?:error|warning):\s*(.+?)\s*$/;
const SUREFIRE_FAILURE_RE =
  /^\s*\[ERROR\]\s+(?:Tests run:.*--\s+in\s+|Failures:\s*$|Errors:\s*$)/;

class StackTraceParser {
  isTestCommand(commandText) {
    return TEST_COMMAND_RE.test(String(commandText || ""));
  }

  outputLooksLikeTests(text) {
    const value = String(text || "");
    if (!value) {
      return false;
    }
    return TEST_OUTPUT_HINTS.some((hint) => value.includes(hint));
  }

  parse(text) {
    const combined = String(text || "");
    if (!combined) {
      return { failures: [], success: false };
    }

    const lines = combined.split(/\r?\n/);
    const failures = [];
    let current = null;
    const MAX_FRAMES = 12;
    const compileBuckets = new Map();

    const flush = () => {
      if (current && (current.frames.length > 0 || current.message)) {
        failures.push(current);
      }
      current = null;
    };

    const recordCompileError = ({ file, line, column, message }) => {
      const key = file;
      let bucket = compileBuckets.get(key);
      if (!bucket) {
        bucket = {
          exception: "java.lang.compile.CompilationError",
          message: "",
          messages: [],
          frames: [],
          source: "javac",
        };
        compileBuckets.set(key, bucket);
      }
      if (bucket.frames.length < MAX_FRAMES) {
        bucket.frames.push({
          class: file,
          method: "<compile>",
          location: column ? `${file}:${line}:${column}` : `${file}:${line}`,
        });
      }
      if (message && bucket.messages.length < 5) {
        bucket.messages.push(`L${line}: ${message}`);
      }
    };

    for (const line of lines) {
      const compileMatch = line.match(MAVEN_COMPILE_ERROR_RE);
      if (compileMatch) {
        recordCompileError({
          file: shortenPath(compileMatch[1]),
          line: Number(compileMatch[2]),
          column: compileMatch[3] ? Number(compileMatch[3]) : null,
          message: compileMatch[4],
        });
        continue;
      }

      const javacMatch = line.match(JAVAC_DIAGNOSTIC_RE);
      if (javacMatch) {
        recordCompileError({
          file: shortenPath(javacMatch[1]),
          line: Number(javacMatch[2]),
          column: null,
          message: javacMatch[3],
        });
        continue;
      }

      const exceptionMatch = line.match(EXCEPTION_LINE_RE);
      if (exceptionMatch) {
        flush();
        current = {
          exception: exceptionMatch[1],
          message: (exceptionMatch[2] || "").trim(),
          frames: [],
        };
        continue;
      }

      const frameMatch = line.match(JAVA_FRAME_RE);
      if (frameMatch && current) {
        if (current.frames.length < MAX_FRAMES) {
          current.frames.push({
            class: frameMatch[1],
            method: frameMatch[2],
            location: frameMatch[3],
          });
        }
        continue;
      }

      const pytestMatch = line.match(PYTEST_EXCEPTION_RE);
      if (pytestMatch) {
        flush();
        current = {
          exception: pytestMatch[1],
          message: (pytestMatch[2] || "").trim(),
          frames: [],
        };
        continue;
      }
    }
    flush();

    for (const bucket of compileBuckets.values()) {
      bucket.message = bucket.messages.join(" | ");
      delete bucket.messages;
      failures.push(bucket);
    }

    if (
      failures.length === 0 &&
      /\[ERROR\][\s\S]*BUILD FAILURE/i.test(combined)
    ) {
      const summaryLine = (combined.match(/^\[ERROR\]\s+(.+)$/m) || [])[1] || "";
      failures.push({
        exception: "BuildFailure",
        message: summaryLine.trim() || "Maven build failed",
        frames: [],
        source: "maven",
      });
    }

    const success =
      failures.length === 0 &&
      /(BUILD SUCCESS|All tests passed|0 failed|0 errors)/i.test(combined);

    return { failures, success };
  }

  summarize(failures) {
    if (!failures?.length) {
      return "Падений тестов не зафиксировано.";
    }
    const counts = new Map();
    for (const failure of failures) {
      counts.set(failure.exception, (counts.get(failure.exception) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([exception, count]) => `${exception} ×${count}`)
      .join(", ");
  }
}

function shortenPath(rawPath) {
  const normalized = String(rawPath || "").replace(/\\/g, "/");
  const marker = "src/main/java/";
  const testMarker = "src/test/java/";
  if (normalized.includes(marker)) {
    return normalized.slice(normalized.lastIndexOf(marker));
  }
  if (normalized.includes(testMarker)) {
    return normalized.slice(normalized.lastIndexOf(testMarker));
  }
  const tail = normalized.split("/").slice(-3).join("/");
  return tail || normalized;
}

module.exports = {
  StackTraceParser,
};
