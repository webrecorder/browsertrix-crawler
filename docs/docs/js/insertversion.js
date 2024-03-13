const KEY = "/.__source";
let retries = 0;

function loadVersion() {
  const value = self.sessionStorage.getItem(KEY);
  if (value) {
    parseVersion(value);
  } else if (retries++ < 10) {
    setTimeout(loadVersion, 500);
  }
}

function parseVersion(string) {
  const version = JSON.parse(string).version;
  if (!version) {
    return;
  }

  const elems = document.querySelectorAll("insert-version");
  for (const elem of elems) {
    try {
      const code = elem.parentElement.nextElementSibling.querySelector("code");
      code.childNodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          node.nodeValue = node.nodeValue.replaceAll("VERSION", version);
        }
      });
    } catch (e) {}
  }
}

if (window.location.pathname.startsWith("/deploy/local")) {
  window.addEventListener("load", () => loadVersion());
}
