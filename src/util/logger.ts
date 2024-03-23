// ===========================================================================
// to fix serialization of regexes for logging purposes

import { Writable } from "node:stream";
import { RedisCrawlState } from "./state.js";

// RegExp.prototype.toJSON = RegExp.prototype.toString;
Object.defineProperty(RegExp.prototype, "toJSON", {
  value: RegExp.prototype.toString,
});

// ===========================================================================
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function formatErr(e: unknown): Record<string, any> {
  if (e instanceof Error) {
    return { type: "exception", message: e.message, stack: e.stack || "" };
  } else if (typeof e === "object") {
    return e || {};
  } else {
    return { message: (e as object).toString() };
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
  fatalExitCode = 17;

  setDefaultFatalExitCode(exitCode: number) {
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
    if (this.logStream) {
      this.logStream.write(string + "\n");
    }

    const toLogToRedis = ["error", "fatal"];
    if (
      this.logErrorsToRedis &&
      this.crawlState &&
      toLogToRedis.includes(logLevel)
    ) {
      this.crawlState.logError(string);
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

  trace(content: string | object, context: LogContext = "general") {
    if (typeof content === "string") {
      this.logAsJSON(content, {}, context, "trace");
    } else {
      this.logAsJSON("Stacktrace", content, context, "trace");
    }
  }

  fatal(
    message: string,
    data = {},
    context: LogContext = "general",
    exitCode = 0,
  ) {
    exitCode = exitCode || this.fatalExitCode;
    this.logAsJSON(`${message}. Quitting`, data, context, "fatal");

    if (this.crawlState) {
      this.crawlState.setStatus("failed").finally(process.exit(exitCode));
    } else {
      process.exit(exitCode);
    }
  }
}

export const logger = new Logger();

export class WACZLogger {
  logger: Logger;

  constructor(loggerInstance: Logger) {
    this.logger = loggerInstance;
  }

  info(message: string) {
    logger.info(message, {}, "wacz");
  }

  error(message: string) {
    logger.error(message, {}, "wacz");
  }

  warn(message: string) {
    logger.warn(message, {}, "wacz");
  }

  trace(content: string | object) {
    logger.trace(content, "wacz");
  }
}
