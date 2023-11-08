import http from "http";
import url from "url";
import { logger } from "./logger.js";

// ===========================================================================
export class HealthChecker {
  port: number;
  errorThreshold: number;
  healthServer: http.Server;

  errorCount = 0;

  constructor(port: number, errorThreshold: number) {
    this.port = port;
    this.errorThreshold = errorThreshold;

    this.healthServer = http.createServer((...args) =>
      this.healthCheck(...args),
    );
    logger.info(`Healthcheck server started on ${port}`, {}, "healthcheck");
    this.healthServer.listen(port);
  }

  async healthCheck(req: http.IncomingMessage, res: http.ServerResponse) {
    const pathname = req.url ? url.parse(req.url).pathname : "";
    switch (pathname) {
      case "/healthz":
        if (this.errorCount < this.errorThreshold) {
          logger.debug(
            `health check ok, num errors ${this.errorCount} < ${this.errorThreshold}`,
            {},
            "healthcheck",
          );
          res.writeHead(200);
          res.end();
        }
        return;
    }

    logger.error(
      `health check failed: ${this.errorCount} >= ${this.errorThreshold}`,
      {},
      "healthcheck",
    );
    res.writeHead(503);
    res.end();
  }

  resetErrors() {
    if (this.errorCount > 0) {
      logger.info(
        `Page loaded, resetting error count ${this.errorCount} to 0`,
        {},
        "healthcheck",
      );
      this.errorCount = 0;
    }
  }

  incError() {
    this.errorCount++;
  }
}
