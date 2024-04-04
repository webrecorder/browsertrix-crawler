import { logger } from "./logger.js";
import { CDPSession, Protocol } from "puppeteer-core";
import { WARCWriter } from "./warcwriter.js";

// ============================================================================
type TextExtractOpts = {
  url: string;
  writer: WARCWriter;
  skipDocs: number;
};

// ============================================================================
export abstract class BaseTextExtract {
  cdp: CDPSession;
  lastText: string | null = null;
  text: string | null = null;
  skipDocs: number = 0;
  writer: WARCWriter;
  url: string;

  constructor(cdp: CDPSession, { writer, skipDocs, url }: TextExtractOpts) {
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
        this.lastText = this.text;
        logger.debug(
          "Skipping, extracted text unchanged from last extraction",
          { url: this.url },
          "text",
        );
        return { changed: false, text };
      }
      if (saveToWarc) {
        this.writer.writeNewResourceRecord({
          buffer: new TextEncoder().encode(text),
          resourceType,
          contentType: "text/plain",
          url: this.url,
        });
        logger.debug(
          `Text Extracted (type: ${resourceType}) for ${this.url} written to ${this.writer.filename}`,
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
export class TextExtractViaDocument extends BaseTextExtract {
  async doGetText(): Promise<string> {
    const result = await this.cdp.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    });
    return this.parseTextFromDOM(result);
  }

  parseTextFromDOM(dom: Protocol.DOM.GetDocumentResponse): string {
    const accum: string[] = [];
    const metadata = {};

    this.parseText(dom.root, metadata, accum);

    return accum.join("\n");
  }

  parseText(
    node: Protocol.DOM.Node,
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
    const EMPTY_LIST: Protocol.DOM.Node[] = [];
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

      if (node.contentDocument) {
        this.parseText(node.contentDocument, null, accum);
      }
    }
  }
}
