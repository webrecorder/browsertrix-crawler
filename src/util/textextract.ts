import { logger } from "./logger.js";
import { CDPSession, Protocol } from "puppeteer-core";
import { WARCWriter } from "./warcwriter.js";
import type { Page } from "puppeteer";
import { JSDOM } from "jsdom";

// ============================================================================
type TextExtractOpts = {
  url: string;
  writer: WARCWriter;
  skipDocs: number;
  ts?: Date;
  page?: Page;
};

// RWP Replay Prefix
const REPLAY_PREFIX = "http://localhost:9990/replay/w/replay/";

// ============================================================================
export abstract class BaseTextExtract {
  cdp: CDPSession;
  lastText: string | null = null;
  text: string | null = null;
  skipDocs: number = 0;
  writer: WARCWriter;
  url: string;
  ts?: Date;
  page?: Page;

  constructor(
    cdp: CDPSession,
    { writer, skipDocs, url, ts, page }: TextExtractOpts,
  ) {
    this.writer = writer;
    this.cdp = cdp;
    this.url = url;
    this.skipDocs = skipDocs || 0;
    this.ts = ts;
    this.page = page;
  }

  async extractAndStoreText(
    resourceType: string,
    ignoreIfMatchesLast = false,
    saveToWarc = false,
  ) {
    try {
      const text = await this.doGetText();

      if (ignoreIfMatchesLast && text === this.lastText) {
        this.lastText = this.text;
        logger.debug(
          "Skipping, extracted text unchanged from last extraction",
          { url: this.url },
          "text",
        );
        return { changed: false, text };
      }
      if (saveToWarc) {
        this.writer.writeNewResourceRecord(
          {
            buffer: new TextEncoder().encode(text),
            resourceType,
            contentType: "text/plain",
            url: this.url,
          },
          {
            resource: "text",
            type: resourceType,
            url: this.url,
            filename: this.writer.filename,
          },
          "text",
        );
      }

      this.lastText = text;
      return { changed: true, text };
    } catch (e) {
      logger.debug("Error extracting text", e, "text");
      return { changed: false, text: null };
    }
  }

  abstract doGetText(): Promise<string>;
}

// ============================================================================
export class TextExtractViaSnapshot extends BaseTextExtract {
  async doGetText(): Promise<string> {
    const result = await this.cdp.send("DOMSnapshot.captureSnapshot", {
      computedStyles: [],
    });
    return this.parseTextFromDOMSnapshot(result);
  }

  parseTextFromDOMSnapshot(
    result: Protocol.DOMSnapshot.CaptureSnapshotResponse,
  ): string {
    const TEXT_NODE = 3;
    const ELEMENT_NODE = 1;

    const SKIPPED_NODES = [
      "SCRIPT",
      "STYLE",
      "HEADER",
      "FOOTER",
      "BANNER-DIV",
      "NOSCRIPT",
      "TITLE",
    ];

    const { strings, documents } = result;

    const accum: string[] = [];

    for (const doc of documents.slice(this.skipDocs)) {
      const nodeValues = doc.nodes.nodeValue || [];
      const nodeNames = doc.nodes.nodeName || [];
      const nodeTypes = doc.nodes.nodeType || [];
      const parentIndex = doc.nodes.parentIndex || [];

      for (let i = 0; i < nodeValues.length; i++) {
        if (nodeValues[i] === -1) {
          continue;
        }

        if (nodeTypes[i] === TEXT_NODE) {
          const pi = parentIndex[i];
          if (pi >= 0 && nodeTypes[pi] === ELEMENT_NODE) {
            const name = strings[nodeNames[pi]];

            if (!SKIPPED_NODES.includes(name)) {
              const value = strings[nodeValues[i]].trim();
              if (value) {
                accum.push(value as string);
              }
            }
          }
        }
      }
    }

    return accum.join("\n");
  }
}

// ============================================================================
export class TextExtractViaResponse extends BaseTextExtract {
  async doGetText(): Promise<string> {
    if (!this.ts) {
      logger.warn(
        "Missing page timestamp, skipping",
        { url: this.url },
        "text",
      );
      throw new Error("Missing page timestamp");
    }
    if (!this.page) {
      logger.error(
        "Missing Page object, unable to continue",
        { url: this.url },
        "text",
      );
      throw new Error("Missing Page object");
    }
    const timestamp = new Date(this.ts)
      .toISOString()
      .slice(0, 19)
      .replace(/[T:-]/g, "");
    // `if_` suffix to timestamp ensures wabac.js serves the unaltered source
    const replayUrl = REPLAY_PREFIX + `${timestamp}if_/${this.url}`;

    const frame = this.page.frames()[1];
    if (!frame) {
      logger.warn(
        "Replay frame missing for CSR clues",
        { url: this.url },
        "text",
      );
      throw new Error("Replay frame missing for CSR clues");
    }

    const result = await frame.evaluate(async (url) => {
      const response = await fetch(url, {
        method: "GET",
        credentials: "include",
      });
      if (response.status !== 200) {
        logger.warn("Got non-200 status code, proceeding", { url }, "text");
      }
      return await response.text();
    }, replayUrl);

    const dom = new JSDOM(result);
    return this.parseTextFromDOM(dom.window.document);
  }

  parseTextFromDOM(dom: typeof document): string {
    const accum: string[] = [];
    const metadata = {};

    this.parseText(dom, metadata, accum);

    return accum.join("\n");
  }

  parseText<T extends Element | Document>(
    node: T,
    metadata: Record<string, string> | null,
    accum: string[],
  ) {
    const SKIPPED_NODES = [
      "head",
      "script",
      "style",
      "header",
      "footer",
      "banner-div",
      "noscript",
    ];
    const EMPTY_LIST: Element[] = [];
    const TEXT = "#text";
    const TITLE = "title";

    const name = node.nodeName.toLowerCase();

    if (SKIPPED_NODES.includes(name)) {
      return;
    }

    const children = node.children || EMPTY_LIST;

    if (name === TEXT) {
      const value = node.nodeValue ? node.nodeValue.trim() : "";
      if (value) {
        accum.push(value);
      }
    } else if (name === TITLE) {
      const title: string[] = [];

      for (const child of children) {
        this.parseText(child, null, title);
      }

      if (metadata) {
        metadata.title = title.join(" ");
      } else {
        accum.push(title.join(" "));
      }
    } else {
      for (const child of children) {
        this.parseText(child, metadata, accum);
      }

      if (
        "contentDocument" in node &&
        (node as HTMLIFrameElement).contentDocument
      ) {
        this.parseText(
          (node as HTMLIFrameElement).contentDocument!,
          null,
          accum,
        );
      }
    }
  }
}
