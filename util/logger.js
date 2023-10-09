// ===========================================================================
// to fix serialization of regexes for logging purposes
RegExp.prototype.toJSON = RegExp.prototype.toString;


// ===========================================================================
export function errJSON(e) {
  return {"type": "exception", "message": e.message, "stack": e.stack};
}


// ===========================================================================
class Logger
{
  constructor() {
    this.logStream = null;
    this.debugLogging = null;
    this.logErrorsToRedis = false;
    this.logLevels = [];
    this.contexts = [];
    this.crawlState = null;

    this.fatalExitCode = 17;
  }

  setDefaultFatalExitCode(exitCode) {
    this.fatalExitCode = exitCode;
  }

  setExternalLogStream(logFH) {
    this.logStream = logFH;
  }

  setDebugLogging(debugLog) {
    this.debugLogging = debugLog;
  }

  setLogErrorsToRedis(logErrorsToRedis) {
    this.logErrorsToRedis = logErrorsToRedis;
  }

  setLogLevel(logLevels) {
    this.logLevels = logLevels;
  }

  setContext(contexts) {
    this.contexts = contexts;
  }

  setCrawlState(crawlState) {
    this.crawlState = crawlState;
  }

  logAsJSON(message, data, context, logLevel="info") {
    if (data instanceof Error) {
      data = errJSON(data);
    } else if (typeof data !== "object") {
      data = {"message": data.toString()};
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

    let dataToLog = {
      "timestamp": new Date().toISOString(),
      "logLevel": logLevel,
      "context": context,
      "message": message,
      "details": data ? data : {}
    };
    const string = JSON.stringify(dataToLog);
    console.log(string);
    if (this.logStream) {
      this.logStream.write(string + "\n");
    }

    const toLogToRedis = ["error", "fatal"];
    if (this.logErrorsToRedis && toLogToRedis.includes(logLevel)) {
      this.crawlState.logError(string);
    }
  }

  info(message, data={}, context="general") {
    this.logAsJSON(message, data, context);
  }

  error(message, data={}, context="general") {
    this.logAsJSON(message, data, context, "error");
  }

  warn(message, data={}, context="general") {
    this.logAsJSON(message, data, context, "warn");
  }

  debug(message, data={}, context="general") {
    if (this.debugLogging) {
      this.logAsJSON(message, data, context, "debug");
    }
  }

  fatal(message, data={}, context="general", exitCode=0) {
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
