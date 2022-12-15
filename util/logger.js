// ===========================================================================

export class Logger
{
  constructor(debugLogging=false) {
    this.debugLogging = debugLogging;
  }

  logAsJSON(message, data, context, logLevel="info") {
    if (typeof data !== "object") {
      data = {"message": data.toString()};
    }
    let dataToLog = {
      "logLevel": logLevel,
      "timestamp": new Date().toISOString(),
      "context": context,
      "message": message,
      "details": data ? data : {}
    };
    console.log(JSON.stringify(dataToLog));
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
