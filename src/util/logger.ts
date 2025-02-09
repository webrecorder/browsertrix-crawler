// ===========================================================================
// to fix serialization of regexes for logging purposes

import { Writable } from "node:stream";
import { RedisCrawlState } from "./state.js";
import { ExitCodes } from "./constants.js";

// RegExp.prototype.toJSON = RegExp.prototype.toString;
Object.defineProperty(RegExp.prototype, "toJSON", {
  value: RegExp.prototype.toString,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LogDetails = Record<string, any>;

// ===========================================================================
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function formatErr(e: unknown): Record<string, any> {
  if (e instanceof Error) {
    return { type: "exception", message: e.message, stack: e.stack || "" };
  } else if (typeof e === "object") {
    return e || {};
  } else {
    return { message: (e as object) + "" };
  }
}

// ===========================================================================
export const LOG_CONTEXT_TYPES = [
  "general",
  "worker",
  "recorder",
  "recorderNetwork",
  "writer",
  "state",
  "redis",
  "storage",
  "text",
  "exclusion",
  "screenshots",
  "screencast",
  "originOverride",
  "healthcheck",
  "browser",
  "blocking",
  "behavior",
  "behaviorScript",
  "jsError",
  "fetch",
  "pageStatus",
  "memoryStatus",
  "crawlStatus",
  "links",
  "sitemap",
  "wacz",
  "replay",
  "proxy",
] as const;

export type LogContext = (typeof LOG_CONTEXT_TYPES)[number];

export const DEFAULT_EXCLUDE_LOG_CONTEXTS: LogContext[] = [
  "recorderNetwork",
  "jsError",
  "screencast",
];

// ===========================================================================
class Logger {
  logStream: Writable | null = null;
  debugLogging = false;
  logErrorsToRedis = false;
  logLevels: string[] = [];
  contexts: LogContext[] = [];
  excludeContexts: LogContext[] = [];
  crawlState?: RedisCrawlState | null = null;
  fatalExitCode: ExitCodes = ExitCodes.Fatal;

  setDefaultFatalExitCode(exitCode: ExitCodes) {
    this.fatalExitCode = exitCode;
  }

  setExternalLogStream(logFH: Writable | null) {
    this.logStream = logFH;
  }

  setDebugLogging(debugLog: boolean) {
    this.debugLogging = debugLog;
  }

  setLogErrorsToRedis(logErrorsToRedis: boolean) {
    this.logErrorsToRedis = logErrorsToRedis;
  }

  setLogLevel(logLevels: string[]) {
    this.logLevels = logLevels;
  }

  setContext(contexts: LogContext[]) {
    this.contexts = contexts;
  }

  setExcludeContext(contexts: LogContext[]) {
    this.excludeContexts = contexts;
  }

  setCrawlState(crawlState: RedisCrawlState) {
    this.crawlState = crawlState;
  }

  logAsJSON(
    message: string,
    dataUnknown: unknown,
    context: LogContext,
    logLevel = "info",
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: Record<string, any> = formatErr(dataUnknown);

    if (this.logLevels.length) {
      if (this.logLevels.indexOf(logLevel) < 0) {
        return;
      }
    }

    if (this.contexts.length) {
      if (this.contexts.indexOf(context) < 0) {
        return;
      }
    }

    if (this.excludeContexts.length) {
      if (this.excludeContexts.indexOf(context) >= 0) {
        return;
      }
    }

    const dataToLog = {
      timestamp: new Date().toISOString(),
      logLevel: logLevel,
      context: context,
      message: message,
      details: data,
    };
    const string = JSON.stringify(dataToLog);
    console.log(string);
    try {
      if (this.logStream) {
        this.logStream.write(string + "\n");
      }
    } catch (e) {
      //
    }

    const toLogToRedis = ["error", "fatal"];
    if (
      this.logErrorsToRedis &&
      this.crawlState &&
      toLogToRedis.includes(logLevel)
    ) {
      this.crawlState.logError(string).catch(() => {});
    }
  }

  info(message: string, data: unknown = {}, context: LogContext = "general") {
    this.logAsJSON(message, data, context);
  }

  error(message: string, data: unknown = {}, context: LogContext = "general") {
    this.logAsJSON(message, data, context, "error");
  }

  warn(message: string, data: unknown = {}, context: LogContext = "general") {
    this.logAsJSON(message, data, context, "warn");
  }

  debug(message: string, data: unknown = {}, context: LogContext = "general") {
    if (this.debugLogging) {
      this.logAsJSON(message, data, context, "debug");
    }
  }

  fatal(
    message: string,
    data = {},
    context: LogContext = "general",
    exitCode?: ExitCodes | undefined,
  ) {
    if (!exitCode) {
      exitCode = this.fatalExitCode;
    }
    this.logAsJSON(`${message}. Quitting`, data, context, "fatal");

    if (this.crawlState) {
      this.crawlState
        .setStatus("failed")
        .catch(() => {})
        .finally(process.exit(exitCode));
    } else {
      process.exit(exitCode);
    }
  }
}

export const logger = new Logger();
