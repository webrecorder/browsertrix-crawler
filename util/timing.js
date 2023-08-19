import { logger } from "./logger.js";

export function sleep(seconds) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

export function timedRun(promise, seconds, message="Promise timed out", logDetails={}, context="general") {
  // return Promise return value or log error if timeout is reached first
  const timeout = seconds * 1000;

  const rejectPromiseOnTimeout = (timeout) => {
    return new Promise((resolve, reject) => {
      setTimeout(() => (reject("timeout reached")), timeout);
    });
  };

  return Promise.race([promise, rejectPromiseOnTimeout(timeout)])
    .catch((err) =>  {
      if (err == "timeout reached") {
        logger.error(message, {"seconds": seconds, ...logDetails}, context);
      } else {
        //logger.error("Unknown exception", {...errJSON(err), ...logDetails}, context);
        throw err;
      }
    });
}

export function secondsElapsed(startTime, nowDate = null) {
  nowDate = nowDate || new Date();

  return (nowDate.getTime() - startTime) / 1000;
}
