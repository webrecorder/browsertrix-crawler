// ===========================================================================
let logStream = null;

export function setExternalLogStream(logFH) {
  logStream = logFH;
}

// ===========================================================================
// to fix serialization of regexes for logging purposes
RegExp.prototype.toJSON = RegExp.prototype.toString;


// ===========================================================================
export function errJSON(e) {
  return {"type": "exception", "message": e.message, "stack": e.stack};
}


// ===========================================================================
export class Logger
{
  constructor(debugLogging=false) {
    this.debugLogging = debugLogging;
  }

  logAsJSON(message, data, context, logLevel="info") {
    if (data instanceof Error) {
      data = errJSON(data);
    } else if (typeof data !== "object") {
      data = {"message": data.toString()};
    }
    let dataToLog = {
      "logLevel": logLevel,
      "timestamp": new Date().toISOString(),
      "context": context,
      "message": message,
      "details": data ? data : {}
    };
    const string = JSON.stringify(dataToLog);
    console.log(string);
    if (logStream) {
      logStream.write(string + "\n");
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

  fatal(message, data={}, context="general", exitCode=1) {
    this.logAsJSON(`${message}. Quitting`, data, context, "fatal");
    process.exit(exitCode);
  }
}
