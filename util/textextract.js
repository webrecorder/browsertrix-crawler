import { WARCResourceWriter } from "./warcresourcewriter.js";
import { logger } from "./logger.js";


// ============================================================================
export class BaseTextExtract extends WARCResourceWriter {
  constructor(cdp, opts) {
    super({...opts, warcName: "text.warc.gz"});
    this.cdp = cdp;
    this.lastText = null;
  }

  async extractAndStoreText(resourceType, ignoreIfMatchesLast = false, saveToWarc = false) {
    try {
      const text = await this.doGetText();

      if (ignoreIfMatchesLast && text === this.lastText) {
        this.lastText = this.text;
        logger.debug("Skipping, extracted text unchanged from last extraction", {url: this.url}, "text");
        return {changed: false, text};
      }
      if (saveToWarc) {
        await this.writeBufferToWARC(new TextEncoder().encode(text), resourceType, "text/plain");
        logger.debug(`Text Extracted (type: ${resourceType}) for ${this.url} written to ${this.warcName}`);
      }

      this.lastText = this.text;
      return {changed: true, text};
    } catch (e) {
      logger.debug("Error extracting text", e, "text");
      return {changed: false, text: null};
    }
  }

  async doGetText() {
    throw new Error("unimplemented");
  }
}


// ============================================================================
export class TextExtractViaSnapshot extends BaseTextExtract {
  async doGetText() {
    const result = await this.cdp.send("DOMSnapshot.captureSnapshot", {computedStyles: []});
    return this.parseTextFromDOMSnapshot(result);
  }

  parseTextFromDOMSnapshot(result) {
    const TEXT_NODE = 3;
    const ELEMENT_NODE = 1;

    const SKIPPED_NODES = ["SCRIPT", "STYLE", "HEADER", "FOOTER", "BANNER-DIV", "NOSCRIPT", "TITLE"];

    const {strings, documents} = result;

    const accum = [];

    for (const doc of documents) {
      const nodeValues = doc.nodes.nodeValue;
      const nodeNames = doc.nodes.nodeName;
      const nodeTypes = doc.nodes.nodeType;
      const parentIndex = doc.nodes.parentIndex;

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
                accum.push(value);
              }
            }
          }
        }
      }

      return accum.join("\n");
    }
  }
}


// ============================================================================
export class TextExtractViaDocument extends BaseTextExtract {
  async doGetText() {
    const result = await this.cdp.send("DOM.getDocument", {"depth": -1, "pierce": true});
    return this.parseTextFromDOM(result);
  }

  async parseTextFromDom(dom) {
    const accum = [];
    const metadata = {};

    this.parseText(dom.root, metadata, accum);

    return accum.join("\n");
  }

  async parseText(node, metadata, accum) {
    const SKIPPED_NODES = ["head", "script", "style", "header", "footer", "banner-div", "noscript"];
    const EMPTY_LIST = [];
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
      const title = [];

      for (let child of children) {
        this.parseText(child, null, title);
      }

      if (metadata) {
        metadata.title = title.join(" ");
      } else {
        accum.push(title.join(" "));
      }
    } else {
      for (let child of children) {
        this.parseText(child, metadata, accum);
      }

      if (node.contentDocument) { 
        this.parseText(node.contentDocument, null, accum);
      } 
    }
  }
}

