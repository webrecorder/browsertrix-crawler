export class TextExtract {
  
  constructor(dom){
    this.dom = dom;
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

  async parseTextFromDom() {
    const accum = [];
    const metadata = {};

    this.parseText(this.dom.root, metadata, accum);

    return accum.join("\n");
  }
}

