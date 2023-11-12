import { LogContext, logger } from "./logger.js";

export function sleep(seconds: number) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

// TODO: Fix this the next time the file is edited.

export function timedRun(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  promise: Promise<any>,
  seconds: number,
  message = "Promise timed out",
  logDetails = {},
  context: LogContext = "general",
  isWarn = false,
) {
  // return Promise return value or log error if timeout is reached first
  const timeout = seconds * 1000;

  const rejectPromiseOnTimeout = (timeout: number) => {
    return new Promise((resolve, reject) => {
      setTimeout(() => reject("timeout reached"), timeout);
    });
  };

  return Promise.race([promise, rejectPromiseOnTimeout(timeout)]).catch(
    (err) => {
      if (err == "timeout reached") {
        const logFunc = isWarn ? logger.warn : logger.error;
        logFunc.call(
          logger,
          message,
          { seconds: seconds, ...logDetails },
          context,
        );
      } else {
        //logger.error("Unknown exception", {...errJSON(err), ...logDetails}, context);
        throw err;
      }
    },
  );
}

export function secondsElapsed(startTime: number, nowDate: Date | null = null) {
  nowDate = nowDate || new Date();

  return (nowDate.getTime() - startTime) / 1000;
}

export function timestampNow() {
  return new Date().toISOString().replace(/[^\d]/g, "");
}
