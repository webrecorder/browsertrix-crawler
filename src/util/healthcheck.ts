import http from "http";
import url from "url";
import { logger } from "./logger.js";


// ===========================================================================
export class HealthChecker
{
  port: number;
  errorCount: number;
  errorThreshold: number;
  healthServer: http.Server;
  
  constructor(port, errorThreshold) {
    this.port = port;
    this.errorCount = 0;
    this.errorThreshold = errorThreshold;

    this.healthServer = http.createServer((...args) => this.healthCheck(...args));
    logger.info(`Healthcheck server started on ${port}`, {}, "healthcheck");
    this.healthServer.listen(port);
  }

  async healthCheck(req, res) {
    const pathname = url.parse(req.url).pathname;
    switch (pathname) {
    case "/healthz":
      if (this.errorCount < this.errorThreshold) {
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
    if (this.errorCount > 0) {
      logger.info(`Page loaded, resetting error count ${this.errorCount} to 0`, {}, "healthcheck");
      this.errorCount = 0;
    }
  }

  incError() {
    this.errorCount++;
  }
}

