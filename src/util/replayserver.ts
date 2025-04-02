import fs from "fs";
import fsp from "fs/promises";
import http, { IncomingMessage, ServerResponse } from "http";
import path from "path";

const replayHTML = fs.readFileSync(
  new URL("../../html/replay.html", import.meta.url),
  { encoding: "utf8" },
);

const swJS = fs.readFileSync(new URL("../../html/rwp/sw.js", import.meta.url), {
  encoding: "utf8",
});

const uiJS = fs.readFileSync(new URL("../../html/rwp/ui.js", import.meta.url), {
  encoding: "utf8",
});

const adblockGZ = fs.readFileSync(
  new URL("../../html/rwp/adblock.gz", import.meta.url),
  {},
);

// ============================================================================
const PORT = 9990;

// ============================================================================
export class ReplayServer {
  sourceUrl: string;
  origFileSource: string | null;
  sourceContentType: string | null;
  sourceSize?: number;

  constructor(sourceUrlOrFile: string) {
    if (
      sourceUrlOrFile.startsWith("http://") ||
      sourceUrlOrFile.startsWith("https://")
    ) {
      this.sourceUrl = sourceUrlOrFile;
      this.origFileSource = null;
      this.sourceContentType = null;
    } else {
      this.origFileSource = sourceUrlOrFile;
      const ext = path.extname(sourceUrlOrFile);
      this.sourceUrl = `/source${ext}`;

      switch (ext) {
        case ".wacz":
          this.sourceContentType = "application/wacz+zip";
          break;

        case ".json":
          this.sourceContentType = "application/json";
          break;

        default:
          this.sourceContentType = "application/octet-stream";
      }
    }
    const httpServer = http.createServer((req, res) =>
      this.handleRequest(req, res),
    );
    httpServer.listen(PORT);
  }

  get homePage() {
    return `http://localhost:${PORT}/`;
  }

  async handleRequest(request: IncomingMessage, response: ServerResponse) {
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
      case "/replay/sw.js":
        response.writeHead(200, { "Content-Type": "application/javascript" });
        response.end(swJS);
        return;

      case "/ui.js":
        response.writeHead(200, { "Content-Type": "application/javascript" });
        response.end(uiJS);
        return;

      case "/replay/adblock/adblock.gz":
        response.writeHead(200, { "Content-Type": "application/gzip" });
        response.end(adblockGZ);
        return;

      case this.sourceUrl:
        if (this.sourceContentType && this.origFileSource) {
          if (!this.sourceSize) {
            const { size } = await fsp.stat(this.origFileSource);
            this.sourceSize = size;
          }
          const { opts, status, contentRange, contentLength } =
            this.getRespOptsForRequest(request, this.sourceSize);
          response.writeHead(status, {
            "Accept-Ranges": "bytes",
            "Content-Type": this.sourceContentType,
            "Content-Length": contentLength,
            "Content-Range": contentRange,
          });
          //console.log(request.method, contentRange, opts);
          if (request.method === "GET") {
            fs.createReadStream(this.origFileSource, opts).pipe(response);
          } else {
            response.end();
          }
          break;
        }
      // falls through

      default:
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
        return;
    }
  }

  getRespOptsForRequest(request: IncomingMessage, total: number) {
    const range = request.headers["range"] || "";
    const array = range.match(/bytes=(\d+)?-(\d*)/);
    let contentRange = undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts: Record<string, any> = {};
    if (array) {
      opts.start = parseInt(array[1]);
      opts.end = parseInt(array[2]);
      // negative value, subtract from end
      if (isNaN(opts.start) && !isNaN(opts.end)) {
        opts.start = total - opts.end;
        opts.end = total - 1;
      } else if (isNaN(opts.end)) {
        opts.end = total - 1;
      }
      contentRange = `bytes ${opts.start}-${opts.end}/${total}`;
      return {
        status: 206,
        opts,
        contentRange,
        contentLength: opts.end - opts.start + 1,
      };
    }
    return { status: 200, opts, contentRange, contentLength: total };
  }
}
