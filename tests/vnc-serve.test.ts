import child_process from "child_process";

let containerId = "";

afterAll(() => {
  if (containerId) {
    try {
      child_process.execSync(`docker kill ${containerId}`);
    } catch (e) {
      // already exited
    }
  }
});

async function fetchWithRetry(url: string, retries = 30): Promise<Response> {
  let lastErr: unknown = null;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        return res;
      }
      lastErr = new Error(`status ${res.status} for ${url}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw lastErr;
}

test("create-login-profile serves the VNC page and novnc client module", async () => {
  containerId = child_process
    .execSync(
      "docker run -d --rm -p 39223:9223 -e VNC_PASS=pass1 webrecorder/browsertrix-crawler create-login-profile --url https://example-com.webrecorder.net/",
      { encoding: "utf-8" },
    )
    .trim();

  const page = await fetchWithRetry("http://localhost:39223/vnc/");
  const pageText = await page.text();
  expect(pageText).toContain('import RFB from "./core/rfb.js"');

  // the module the VNC page imports must resolve from the installed novnc package
  const rfb = await fetchWithRetry("http://localhost:39223/vnc/core/rfb.js");
  const rfbText = await rfb.text();
  expect(rfbText).toContain("export default class RFB");
}, 120000);
