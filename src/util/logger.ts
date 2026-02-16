// ===========================================================================
// to fix serialization of regexes for logging purposes

import { Writable } from "node:stream";
import { RedisCrawlState } from "./state.js";
import { ExitCodes } from "./constants.js";
import { streamFinish } from "./warcwriter.js";
import fs from "node:fs";

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
  "robots",
  "dedupe",
] as const;

export type LogContext = (typeof LOG_CONTEXT_TYPES)[number];

export const LOG_LEVEL_TYPES = [
  "debug",
  "info",
  "warn",
  "error",
  "interrupt",
  "fatal",
] as const;

export type LogLevel = (typeof LOG_LEVEL_TYPES)[number];

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
  logLevels: LogLevel[] = [];
  contexts: LogContext[] = [];
  excludeContexts: LogContext[] = [];
  defaultLogContext: LogContext = "general";
  crawlState?: RedisCrawlState | null = null;
  fatalExitCode: ExitCodes = ExitCodes.Fatal;

  setDefaultLogContext(value: LogContext) {
    this.defaultLogContext = value;
  }

  setDefaultFatalExitCode(exitCode: number) {
    this.fatalExitCode = exitCode;
  }

  setOutputFile(filename: string) {
    this.logStream = fs.createWriteStream(filename, { flags: "a" });
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

  setLogLevel(logLevels: LogLevel[]) {
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

    const redisErrorLogLevels = ["error", "interrupt", "fatal"];
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

  info(
    message: string,
    data: unknown = {},
    context: LogContext = this.defaultLogContext,
  ) {
    this.logAsJSON(message, data, context, "info");
  }

  error(
    message: string,
    data: unknown = {},
    context: LogContext = this.defaultLogContext,
  ) {
    this.logAsJSON(message, data, context, "error");
  }

  warn(
    message: string,
    data: unknown = {},
    context: LogContext = this.defaultLogContext,
  ) {
    this.logAsJSON(message, data, context, "warn");
  }

  debug(
    message: string,
    data: unknown = {},
    context: LogContext = this.defaultLogContext,
  ) {
    if (this.debugLogging) {
      this.logAsJSON(message, data, context, "debug");
    }
  }

  interrupt(
    message: string,
    data = {},
    context: LogContext,
    exitCode: ExitCodes,
  ) {
    this.logAsJSON(
      `${message}. Interrupting, can restart`,
      data,
      context,
      "interrupt",
    );

    void this.setStatusAndExit(exitCode, "interrupted");
  }

  fatal(
    message: string,
    data = {},
    context: LogContext = this.defaultLogContext,
    exitCode = ExitCodes.Success,
  ) {
    this.logAsJSON(`${message}. Quitting`, data, context, "fatal");

    void this.setStatusAndExit(exitCode || this.fatalExitCode, "interrupted");
  }

  async closeLog() {
    if (this.logStream) {
      const logFH = this.logStream;
      this.logStream = null;
      await streamFinish(logFH);
    }
  }

  async setStatusAndExit(exitCode: ExitCodes, status: string): Promise<void> {
    try {
      await this.closeLog();

      if (this.crawlState && status) {
        await this.crawlState.setStatus(status);
      }
    } catch (e) {
      this.logAsJSON(
        "Error shutting down, exiting anyway",
        e,
        this.defaultLogContext,
        "error",
      );
    } finally {
      process.exit(exitCode);
    }
  }
}

export const logger = new Logger();
