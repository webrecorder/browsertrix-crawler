import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { Agent, request } from "undici";
import { trackRemoteIPAddress } from "../src/util/undici-ip.js";

test("associates an Undici request with its actual peer socket", async () => {
  const server = createServer((_req, res) => {
    res.end("ok");
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const { port } = server.address() as AddressInfo;
  const agent = new Agent();
  let remoteAddress: string | undefined;
  const dispatcher = trackRemoteIPAddress(agent, (address) => {
    remoteAddress = address;
  });

  try {
    const resp = await request(`http://127.0.0.1:${port}/`, { dispatcher });
    await resp.body.text();
    expect(remoteAddress).toBe("127.0.0.1");
  } finally {
    await dispatcher.close();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});
