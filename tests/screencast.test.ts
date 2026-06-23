import child_process from "child_process";
import WebSocket from "ws";

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

function connectAndReadFirstMessage(url: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Promise<any>((resolve, reject) => {
    const sock = new WebSocket(url);
    const timer = setTimeout(() => {
      sock.terminate();
      reject(new Error("timed out waiting for message"));
    }, 5000);
    sock.on("message", (data) => {
      clearTimeout(timer);
      const parsed = JSON.parse(data.toString());
      sock.close();
      resolve(parsed);
    });
    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

test("screencast server sends init message to websocket client during crawl", async () => {
  containerId = child_process
    .execSync(
      "docker run -d --rm -p 39037:9037 webrecorder/browsertrix-crawler crawl --url https://example-com.webrecorder.net/ --limit 1 --screencastPort 9037 --collection screencast-test",
      { encoding: "utf-8" },
    )
    .trim();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let firstMessage: any = null;
  let lastErr: unknown = null;

  // retry until the screencast server inside the container is up
  for (let i = 0; i < 30 && !firstMessage; i++) {
    try {
      firstMessage = await connectAndReadFirstMessage(
        "ws://localhost:39037/ws",
      );
    } catch (e) {
      lastErr = e;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  if (!firstMessage) {
    throw lastErr;
  }

  expect(firstMessage.msg).toBe("init");
  expect(firstMessage.browsers).toBe(1);
  expect(firstMessage.width).toBeGreaterThan(0);
  expect(firstMessage.height).toBeGreaterThan(0);
}, 120000);
