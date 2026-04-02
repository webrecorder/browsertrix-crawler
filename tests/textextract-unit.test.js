import { extractTextFromDOM, extractTextFromDOMSnapshot } from "../src/util/textextract.js";
import { JSDOM } from "jsdom";

describe("extractTextFromDOM", () => {
  test("extracts text from simple HTML", () => {
    const html = `
      <html>
        <body>
          <h1>Title</h1>
          <p>Paragraph text</p>
        </body>
      </html>
    `;
    const dom = new JSDOM(html);
    const text = extractTextFromDOM(dom.window.document);
    
    expect(text).toContain("Title");
    expect(text).toContain("Paragraph text");
  });

  test("skips script and style content", () => {
    const html = `
      <html>
        <head>
          <style>body { color: red; }</style>
        </head>
        <body>
          <p>Visible text</p>
          <script>var x = 'hidden';</script>
        </body>
      </html>
    `;
    const dom = new JSDOM(html);
    const text = extractTextFromDOM(dom.window.document);
    
    expect(text).toContain("Visible text");
    expect(text).not.toContain("color: red");
    expect(text).not.toContain("hidden");
  });

  test("skips header, footer, and noscript", () => {
    const html = `
      <html>
        <body>
          <header>Header content</header>
          <main>Main content</main>
          <footer>Footer content</footer>
          <noscript>No script content</noscript>
        </body>
      </html>
    `;
    const dom = new JSDOM(html);
    const text = extractTextFromDOM(dom.window.document);
    
    expect(text).toContain("Main content");
    expect(text).not.toContain("Header content");
    expect(text).not.toContain("Footer content");
    expect(text).not.toContain("No script content");
  });

  test("skips title tag content", () => {
    const html = `
      <html>
        <head><title>Page Title</title></head>
        <body>
          <p>Body content</p>
        </body>
      </html>
    `;
    const dom = new JSDOM(html);
    const text = extractTextFromDOM(dom.window.document);
    
    expect(text).toContain("Body content");
    expect(text).not.toContain("Page Title");
  });

  test("handles deeply nested elements", () => {
    const html = `
      <html>
        <body>
          <div>
            <div>
              <div>
                <p>Deeply nested text</p>
              </div>
            </div>
          </div>
        </body>
      </html>
    `;
    const dom = new JSDOM(html);
    const text = extractTextFromDOM(dom.window.document);
    
    expect(text).toContain("Deeply nested text");
  });

  test("returns empty string for empty document", () => {
    const html = `<html><body></body></html>`;
    const dom = new JSDOM(html);
    const text = extractTextFromDOM(dom.window.document);
    
    expect(text).toBe("");
  });

  test("trims whitespace from text nodes", () => {
    const html = `
      <html>
        <body>
          <p>   Text with whitespace   </p>
        </body>
      </html>
    `;
    const dom = new JSDOM(html);
    const text = extractTextFromDOM(dom.window.document);
    
    expect(text).toBe("Text with whitespace");
  });
});

describe("extractTextFromDOMSnapshot", () => {
  test("extracts text from CDP DOMSnapshot format", () => {
    const snapshot = {
      strings: ["HTML", "BODY", "P", "Hello World", "SCRIPT", "hidden"],
      documents: [{
        nodes: {
          nodeType: [1, 1, 1, 3, 1, 3],
          nodeName: [0, 1, 2, -1, 4, -1],
          nodeValue: [-1, -1, -1, 3, -1, 5],
          parentIndex: [-1, 0, 1, 2, 1, 4],
        },
      }],
    };
    
    const text = extractTextFromDOMSnapshot(snapshot);
    
    expect(text).toContain("Hello World");
    expect(text).not.toContain("hidden");
  });

  test("handles empty snapshot", () => {
    const snapshot = {
      strings: [],
      documents: [{
        nodes: {
          nodeType: [],
          nodeName: [],
          nodeValue: [],
          parentIndex: [],
        },
      }],
    };
    
    const text = extractTextFromDOMSnapshot(snapshot);
    
    expect(text).toBe("");
  });

  test("skips documents based on skipDocs parameter", () => {
    const snapshot = {
      strings: ["HTML", "BODY", "P", "First Doc", "HTML", "BODY", "P", "Second Doc"],
      documents: [
        {
          nodes: {
            nodeType: [1, 1, 1, 3],
            nodeName: [0, 1, 2, -1],
            nodeValue: [-1, -1, -1, 3],
            parentIndex: [-1, 0, 1, 2],
          },
        },
        {
          nodes: {
            nodeType: [1, 1, 1, 3],
            nodeName: [4, 5, 6, -1],
            nodeValue: [-1, -1, -1, 7],
            parentIndex: [-1, 0, 1, 2],
          },
        },
      ],
    };
    
    const textWithSkip = extractTextFromDOMSnapshot(snapshot, 1);
    const textWithoutSkip = extractTextFromDOMSnapshot(snapshot, 0);
    
    expect(textWithSkip).toContain("Second Doc");
    expect(textWithSkip).not.toContain("First Doc");
    expect(textWithoutSkip).toContain("First Doc");
    expect(textWithoutSkip).toContain("Second Doc");
  });
});
