import fs from "fs";
import http, { IncomingMessage, ServerResponse } from "http";

const replayHTML = fs.readFileSync(
  new URL("../../html/replay.html", import.meta.url),
  { encoding: "utf8" },
);

const swJS = fs.readFileSync(new URL("../../html/sw.js", import.meta.url), {
  encoding: "utf8",
});

// ============================================================================
const PORT = 9990;

// ============================================================================
export class ReplayServer {
  sourceUrl: string;

  constructor(sourceUrl: string) {
    this.sourceUrl = sourceUrl;
    const httpServer = http.createServer((req, res) =>
      this.handleRequest(req, res),
    );
    httpServer.listen(PORT);
  }

  get homePage() {
    return `http://localhost:${PORT}/`;
  }

  handleRequest(request: IncomingMessage, response: ServerResponse) {
    const parsedUrl = new URL(
      request.url || "",
      `http://${request.headers.host}`,
    );
    const pathname = parsedUrl.pathname;

    switch (pathname) {
      case "/":
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(replayHTML.replace("$SOURCE", this.sourceUrl));
        return;

      case "/sw.js":
      case "/sw.js?serveIndex=1":
      case "/replay/sw.js":
      case "/replay/sw.js?serveIndex=1":
        response.writeHead(200, { "Content-Type": "application/javascript" });
        response.end(swJS);
        return;

      default:
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
        return;
    }
  }
}
