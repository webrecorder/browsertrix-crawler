import { Protocol } from "puppeteer-core";
import { JSDOM } from "jsdom";

type Snapshot = {
  doc: Document;
  nodes: (Node | null)[];
  doctype: string;
};

export function snapshotToDom(
  response: Protocol.DOMSnapshot.CaptureSnapshotResponse,
) {
  const dom = new JSDOM();
  const doc = dom.window.document;

  const snapshot: Snapshot = {
    doc,
    nodes: [],
    doctype: "",
  };

  // will be re-created below
  doc.removeChild(doc.documentElement);

  snapshot.nodes.push(doc);

  const { documents, strings } = response;
  if (!documents.length) {
    throw new Error("no snapshot documents");
  }

  const nodes = documents[0].nodes;

  if (
    !nodes.nodeType ||
    !nodes.nodeName ||
    !nodes.nodeValue ||
    !nodes.parentIndex ||
    !nodes.attributes
  ) {
    throw new Error("invalid snapshot");
  }

  const length = nodes.nodeType?.length || 0;

  for (let i = 1; i < length; i++) {
    createNode(
      snapshot,
      nodes.nodeType[i],
      strings[nodes.nodeName[i]],
      strings[nodes.nodeValue[i]],
      nodes.attributes[i].map((x) => (x >= 0 ? strings[x] : "")),
      nodes.parentIndex[i],
    );
  }

  return snapshot.doctype + dom.serialize().replaceAll("stylex", "style");
}

function createNode(
  snapshot: Snapshot,
  nodeType: number,
  nodeName: string,
  nodeValue: string,
  attrs: string[],
  parentIndex: number,
) {
  let node: Node | null = null;

  const { doc, nodes } = snapshot;

  switch (nodeType) {
    case doc.ELEMENT_NODE:
      {
        if (nodeName === "SCRIPT" || nodeName.startsWith("::")) {
          node = null;
          break;
        }
        if (nodeName === "STYLE") {
          nodeName = "STYLEX";
        }
        const elem = doc.createElement(nodeName);
        for (let i = 0; i < attrs.length; i += 2) {
          elem.setAttribute(attrs[i], attrs[i + 1]);
        }
        node = elem;
      }
      break;

    case doc.TEXT_NODE:
      node = doc.createTextNode(nodeValue);
      break;

    case doc.CDATA_SECTION_NODE:
      node = doc.createCDATASection(nodeValue);
      break;

    case doc.PROCESSING_INSTRUCTION_NODE:
      node = doc.createProcessingInstruction("", "");
      break;

    case doc.COMMENT_NODE:
      node = doc.createComment(nodeValue);
      break;

    case doc.DOCUMENT_NODE:
      node = doc.createComment("invalid node: document");
      break;

    case doc.DOCUMENT_FRAGMENT_NODE:
      node = doc.createDocumentFragment();
      break;

    case doc.DOCUMENT_TYPE_NODE:
      node = null;
      snapshot.doctype = `<!doctype ${nodeName}>\n`;
      break;

    default:
      node = doc.createComment("unknown node");
  }

  if (parentIndex >= 0) {
    const elem = nodes[parentIndex] as Element;
    if (elem && node) {
      elem.appendChild(node);
    }
  }

  nodes.push(node);
}
