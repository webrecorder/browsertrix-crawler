import http from "http";
import url from "url";
import { logger } from "./logger.js";


// ===========================================================================
export class HealthChecker
{
  constructor(port, errorThreshold) {
    this.port = port;
    this.errorCount = 0;
    this.errorThreshold = errorThreshold;
    this.resetCount = 0;

    this.healthServer = http.createServer((...args) => this.healthCheck(...args));
    logger.info(`Healthcheck server started on ${port}`, {}, "healthcheck");
    this.healthServer.listen(port);
  }

  isFailing() {
    return this.errorCount >= this.errorThreshold;
  }

  async healthCheck(req, res) {
    const pathname = url.parse(req.url).pathname;
    switch (pathname) {
    case "/healthz":
      if (!this.isFailing()) {
        logger.debug(`health check ok, num errors ${this.errorCount} < ${this.errorThreshold}`, {}, "healthcheck");
        res.writeHead(200);
        res.end();
      }
      return;
    }

    logger.error(`health check failed: ${this.errorCount} >= ${this.errorThreshold}`, {}, "healthcheck");
    res.writeHead(503);
    res.end();
  }

  resetErrors() {
    this.resetCount++;
    if (this.errorCount > 0 && this.resetCount >= 2) {
      logger.info(`Page loaded, resetting error count ${this.errorCount} to 0`, {}, "healthcheck");
      this.errorCount = 0;
      this.resetCount = 0;
    } else if (!this.errorCount) {
      this.resetCount = 0;
    }
  }

  incError() {
    this.errorCount++;
  }
}

