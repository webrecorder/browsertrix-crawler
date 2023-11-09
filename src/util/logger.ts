// ===========================================================================
// to fix serialization of regexes for logging purposes

import { Writable } from "node:stream";
import { RedisCrawlState } from "./state.js";

// RegExp.prototype.toJSON = RegExp.prototype.toString;
Object.defineProperty(RegExp.prototype, "toJSON", {
  value: RegExp.prototype.toString,
});

// ===========================================================================
// TODO: Fix this the next time the file is edited.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function errJSON(e: any) {
  if (e instanceof Error) {
    return { type: "exception", message: e.message, stack: e.stack };
  } else {
    return { message: e.toString() };
  }
}

// ===========================================================================
class Logger {
  logStream: Writable | null = null;
  debugLogging = false;
  logErrorsToRedis = false;
  logLevels: string[] = [];
  contexts: string[] = [];
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

  setContext(contexts: string[]) {
    this.contexts = contexts;
  }

  setCrawlState(crawlState: RedisCrawlState) {
    this.crawlState = crawlState;
  }

  // TODO: Fix this the next time the file is edited.

  logAsJSON(
    message: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: Record<string, string> | Error | any,
    context: string,
    logLevel = "info",
  ) {
    if (data instanceof Error) {
      data = errJSON(data);
    } else if (typeof data !== "object") {
      data = { message: data.toString() };
    }

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

    const dataToLog = {
      timestamp: new Date().toISOString(),
      logLevel: logLevel,
      context: context,
      message: message,
      details: data ? data : {},
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

  info(message: string, data = {}, context = "general") {
    this.logAsJSON(message, data, context);
  }

  error(message: string, data = {}, context = "general") {
    this.logAsJSON(message, data, context, "error");
  }

  warn(message: string, data = {}, context = "general") {
    this.logAsJSON(message, data, context, "warn");
  }

  debug(message: string, data = {}, context = "general") {
    if (this.debugLogging) {
      this.logAsJSON(message, data, context, "debug");
    }
  }

  fatal(message: string, data = {}, context = "general", exitCode = 0) {
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
