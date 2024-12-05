import { logger } from "./logger.js";
import { CDPSession, Protocol } from "puppeteer-core";
import { WARCWriter } from "./warcwriter.js";

// ============================================================================
type DomExtractOpts = {
  url: string;
  writer: WARCWriter;
  skipDocs: number;
};

// ============================================================================
export abstract class BaseDomExtract {
  cdp: CDPSession;
  lastDom: string | null = null;
  dom: string | null = null;
  skipDocs: number = 0;
  writer: WARCWriter;
  url: string;

  constructor(cdp: CDPSession, { writer, skipDocs, url }: DomExtractOpts) {
    this.writer = writer;
    this.cdp = cdp;
    this.url = url;
    this.skipDocs = skipDocs || 0;
  }

  async extractAndStoreDom(
    resourceType: string,
    ignoreIfMatchesLast = false,
    saveToWarc = false,
  ) {
    try {
      const dom = await this.doGetDom();

      if (ignoreIfMatchesLast && dom === this.lastDom) {
        this.lastDom = this.dom;
        logger.debug(
          "Skipping, extracted DOM unchanged from last extraction",
          { url: this.url },
          "dom",
        );
        return { changed: false, dom };
      }
      if (saveToWarc) {
        this.writer.writeNewResourceRecord(
          {
            buffer: new TextEncoder().encode(dom),
            resourceType,
            contentType: "text/html",
            url: this.url,
          },
          {
            resource: "dom",
            type: resourceType,
            url: this.url,
            filename: this.writer.filename,
          },
          "dom",
        );
      }

      this.lastDom = dom;
      return { changed: true, dom };
    } catch (e) {
      logger.debug("Error extracting DOM", e, "dom");
      return { changed: false, dom: null };
    }
  }

  abstract doGetDom(): Promise<string>;
}

// ============================================================================
export class DomExtractViaSnapshot extends BaseDomExtract {
  async doGetDom(): Promise<string> {

    // Get the root document node
    const { root } = await this.cdp.send("DOM.getDocument", {});
    
    // Get the outer HTML of the root node
    const { outerHTML } = await this.cdp.send("DOM.getOuterHTML", {
      nodeId: root.nodeId,
    });

    return outerHTML;

  }
}