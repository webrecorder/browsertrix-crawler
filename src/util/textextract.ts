type DOMNode = {
  children: DOMNode[];
  nodeName: string;
  nodeValue: string;
  contentDocument?: DOMNode;
}

export class TextExtract {
  
  dom: {root: DOMNode};

  constructor(dom: {root: DOMNode}){
    this.dom = dom;
  }

  async parseText(node: DOMNode, metadata: Record<string, string> | null, accum: string[]) {
    const SKIPPED_NODES = ["head", "script", "style", "header", "footer", "banner-div", "noscript"];
    const EMPTY_LIST : DOMNode[] = [];
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
      const title : string[] = [];

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
    const accum : string[] = [];
    const metadata = {};

    this.parseText(this.dom.root, metadata, accum);

    return accum.join("\n");
  }
}

