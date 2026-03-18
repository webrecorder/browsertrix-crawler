import { logger } from "./logger.js";
import { CDPSession, Protocol } from "puppeteer-core";
import { WARCWriter } from "./warcwriter.js";
import { JSDOM } from "jsdom";

// ============================================================================
interface TextExtractOptsBase {
  url: string;
  writer: WARCWriter;
  skipDocs: number;
}

interface TextExtractViaResponseOpts extends TextExtractOptsBase {
  requestId?: string;
}

// ============================================================================
export abstract class BaseTextExtract {
  protected cdp: CDPSession;
  protected lastText: string | null = null;
  protected skipDocs: number = 0;
  protected writer: WARCWriter;
  protected url: string;

  constructor(cdp: CDPSession, { writer, skipDocs, url }: TextExtractOptsBase) {
    this.writer = writer;
    this.cdp = cdp;
    this.url = url;
    this.skipDocs = skipDocs || 0;
  }

  async extractAndStoreText(
    resourceType: string,
    ignoreIfMatchesLast = false,
    saveToWarc = false,
  ) {
    try {
      const text = await this.doGetText();

      if (ignoreIfMatchesLast && text === this.lastText) {
        this.lastText = text;
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
  protected requestId: string | undefined;

  constructor(cdp: CDPSession, opts: TextExtractViaResponseOpts) {
    super(cdp, opts);
    this.requestId = opts.requestId;
  }

  async doGetText(): Promise<string> {
    if (!this.requestId) {
      logger.warn(
        "Missing document request ID, skipping",
        { url: this.url },
        "text",
      );
      throw new Error("Missing document request ID");
    }

    logger.info(
      "Fetching raw response body via CDP",
      { url: this.url, requestId: this.requestId },
      "text",
    );

    try {
      const { body, base64Encoded } = await this.cdp.send(
        "Network.getResponseBody",
        {
          requestId: this.requestId,
        },
      );

      const text = base64Encoded
        ? Buffer.from(body, "base64").toString()
        : body;

      logger.info(
        "Got raw response body",
        { url: this.url, size: text.length },
        "text",
      );

      const dom = new JSDOM(text, {
        runScripts: undefined,
        resources: undefined,
      });
      try {
        const extracted = this.parseTextFromDOM(dom.window.document);
        logger.info(
          "Extracted text from raw response",
          { url: this.url, textLength: extracted.length },
          "text",
        );
        return extracted;
      } finally {
        dom.window.close();
      }
    } catch (e) {
      logger.error(
        "Failed to get response body",
        { url: this.url, requestId: this.requestId, error: String(e) },
        "text",
      );
      throw e;
    }
  }

  parseTextFromDOM(dom: Document): string {
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

    // Build flat arrays similar to DOMSnapshot format
    const nodeValues: string[] = [];
    const nodeNames: string[] = [];
    const nodeTypes: number[] = [];
    const parentIndex: number[] = [];
    const nodeToIndex = new Map<Node, number>();

    // Use window.NodeFilter from the document's window (required for JSDOM)
    const window = dom.defaultView!;
    const walker = dom.createTreeWalker(
      dom,
      window.NodeFilter.SHOW_ELEMENT | window.NodeFilter.SHOW_TEXT,
      null,
    );

    let node: Node | null;
    while ((node = walker.nextNode())) {
      nodeToIndex.set(node, nodeValues.length);
      nodeTypes.push(node.nodeType);

      if (node.nodeType === TEXT_NODE) {
        nodeValues.push(node.textContent || "");
        nodeNames.push("");
      } else {
        nodeValues.push("");
        nodeNames.push((node as Element).tagName);
      }

      const parent = node.parentNode;
      if (parent && nodeToIndex.has(parent)) {
        parentIndex.push(nodeToIndex.get(parent)!);
      } else {
        parentIndex.push(-1);
      }
    }

    // Extract text using same logic as snapshot
    const accum: string[] = [];

    for (let i = 0; i < nodeValues.length; i++) {
      if (nodeValues[i] === "") {
        continue;
      }

      if (nodeTypes[i] === TEXT_NODE) {
        const pi = parentIndex[i];
        if (pi >= 0 && nodeTypes[pi] === ELEMENT_NODE) {
          const name = nodeNames[pi];

          if (!SKIPPED_NODES.includes(name)) {
            const value = nodeValues[i].trim();
            if (value) {
              accum.push(value);
            }
          }
        }
      }
    }

    return accum.join("\n");
  }
}
