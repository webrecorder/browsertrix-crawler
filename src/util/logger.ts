// ===========================================================================
// to fix serialization of regexes for logging purposes

import { Writable } from "node:stream";
import fs from "node:fs";
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
  "behaviorScriptCustom",
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
  "scope",
] as const;

export type LogContext = (typeof LOG_CONTEXT_TYPES)[number];

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

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
  logBehaviorsToRedis = false;
  logLevels: string[] = [];
  contexts: LogContext[] = [];
  excludeContexts: LogContext[] = [];
  crawlState?: RedisCrawlState | null = null;
  fatalExitCode: ExitCodes = ExitCodes.Fatal;
  logFH: Writable | null = null;

  setDefaultFatalExitCode(exitCode: number) {
    this.fatalExitCode = exitCode;
  }

  openLog(filename: string) {
    this.logFH = fs.createWriteStream(filename, { flags: "a" });
  }

  async closeLog(): Promise<void> {
    // close file-based log
    if (!this.logFH) {
      return;
    }
    const logFH = this.logFH;
    this.logFH = null;
    await streamFinish(logFH);
  }

  setDebugLogging(debugLog: boolean) {
    this.debugLogging = debugLog;
  }

  setLogErrorsToRedis(logErrorsToRedis: boolean) {
    this.logErrorsToRedis = logErrorsToRedis;
  }

  setLogBehaviorsToRedis(logBehaviorsToRedis: boolean) {
    this.logBehaviorsToRedis = logBehaviorsToRedis;
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
    logLevel: LogLevel,
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

    const redisErrorLogLevels = ["error", "fatal"];
    if (
      this.logErrorsToRedis &&
      this.crawlState &&
      redisErrorLogLevels.includes(logLevel)
    ) {
      this.crawlState.logError(string).catch(() => {});
    }

    const redisBehaviorLogLevels = ["info", "warn", "error"];
    const behaviorContexts = ["behavior", "behaviorScript"];
    if (
      this.logBehaviorsToRedis &&
      this.crawlState &&
      ((behaviorContexts.includes(context) &&
        redisBehaviorLogLevels.includes(logLevel)) ||
        //always include behaviorScriptCustom
        context === "behaviorScriptCustom")
    ) {
      this.crawlState.logBehavior(string).catch(() => {});
    }
  }

  info(message: string, data: unknown = {}, context: LogContext = "general") {
    this.logAsJSON(message, data, context, "info");
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
    exitCode = ExitCodes.Success,
  ) {
    exitCode = exitCode || this.fatalExitCode;
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

  async interrupt(
    message: string,
    data = {},
    exitCode: ExitCodes,
    status = "interrupted",
  ) {
    if (message) {
      this.error(`${message}: exiting, crawl status: ${status}`, data);
    } else {
      this.info(`exiting, crawl status: ${status}`);
    }

    await this.closeLog();

    if (this.crawlState && status) {
      await this.crawlState.setStatus(status);
    }
    process.exit(exitCode);
  }
}

// =================================================================
export function streamFinish(fh: Writable) {
  const p = new Promise<void>((resolve) => {
    fh.once("finish", () => resolve());
  });
  fh.end();
  return p;
}

export const logger = new Logger();
