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
    refersTo?: string,
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
            refersTo,
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
    return extractTextFromDOMSnapshot(result, this.skipDocs);
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
    return extractTextFromDOM(dom);
  }
}

// ============================================================================
// Shared text extraction utilities
// ============================================================================

// Nodes to skip when extracting text (headers, scripts, etc.)
const SKIPPED_NODES = [
  "SCRIPT",
  "STYLE",
  "HEADER",
  "FOOTER",
  "BANNER-DIV",
  "NOSCRIPT",
  "TITLE",
];

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/**
 * Normalized node data for text extraction.
 * Can come from CDP DOMSnapshot or from DOM tree walker.
 */
interface NodeData {
  values: (string | number)[];
  names: (string | number)[];
  types: number[];
  parentIndex: number[];
  strings?: string[]; // For DOMSnapshot: lookup table for string indices
}

/**
 * Extract text from normalized node data.
 * Shared logic used by both DOMSnapshot and DOM walker extraction.
 */
function extractTextFromNodes(data: NodeData, skipDocs = 0): string {
  const { values, names, types, parentIndex, strings } = data;
  const accum: string[] = [];

  // Helper to get string value (handle both direct strings and indices)
  const getValue = (val: string | number): string => {
    if (typeof val === "string") return val;
    // For DOMSnapshot: -1 means no value
    if (val === -1) return "";
    return strings?.[val] ?? "";
  };

  const getName = (val: string | number): string => {
    if (typeof val === "string") return val;
    return strings?.[val] ?? "";
  };

  const startIdx = skipDocs;
  const endIdx = values.length;

  for (let i = startIdx; i < endIdx; i++) {
    const textValue = getValue(values[i]);

    // Skip empty values (-1 for snapshot indices, "" for direct strings)
    if (textValue === "" || values[i] === -1) {
      continue;
    }

    if (types[i] === TEXT_NODE) {
      const pi = parentIndex[i];
      if (pi >= 0 && types[pi] === ELEMENT_NODE) {
        const name = getName(names[pi]);

        if (!SKIPPED_NODES.includes(name)) {
          const value = textValue.trim();
          if (value) {
            accum.push(value);
          }
        }
      }
    }
  }

  return accum.join("\n");
}

/**
 * Extract text from CDP DOMSnapshot response.
 */
export function extractTextFromDOMSnapshot(
  result: Protocol.DOMSnapshot.CaptureSnapshotResponse,
  skipDocs = 0,
): string {
  const { strings, documents } = result;
  const accum: string[] = [];

  for (const doc of documents.slice(skipDocs)) {
    const nodeData: NodeData = {
      values: doc.nodes.nodeValue || [],
      names: doc.nodes.nodeName || [],
      types: doc.nodes.nodeType || [],
      parentIndex: doc.nodes.parentIndex || [],
      strings,
    };

    accum.push(extractTextFromNodes(nodeData));
  }

  return accum.join("\n");
}

/**
 * Extract text content from a DOM Document.
 * Uses createTreeWalker for efficient traversal.
 * Works with both browser DOM and JSDOM.
 */
export function extractTextFromDOM(dom: Document): string {
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

  const nodeData: NodeData = {
    values: nodeValues,
    names: nodeNames,
    types: nodeTypes,
    parentIndex,
  };

  return extractTextFromNodes(nodeData);
}
