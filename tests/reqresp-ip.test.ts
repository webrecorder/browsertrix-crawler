import { Protocol } from "puppeteer-core";
import { RequestResponseInfo } from "../src/util/reqresp.js";

function response(remoteIPAddress?: string) {
  return {
    url: "https://example.com/",
    status: 200,
    statusText: "OK",
    headers: {},
    mimeType: "text/html",
    protocol: "h2",
    remoteIPAddress,
  } as Protocol.Network.Response;
}

test.each(["192.0.2.10", "2001:db8::10"])(
  "stores a valid remote IP address: %s",
  (remoteIPAddress) => {
    const reqresp = new RequestResponseInfo("request-1");
    reqresp.fillResponse(response(remoteIPAddress), "Document");
    expect(reqresp.remoteIPAddress).toBe(remoteIPAddress);
  },
);

test.each([undefined, "", "example.com", "192.0.2.999"])(
  "does not store a missing or invalid remote IP address: %s",
  (remoteIPAddress) => {
    const reqresp = new RequestResponseInfo("request-1");
    reqresp.fillResponse(response(remoteIPAddress), "Document");
    expect(reqresp.remoteIPAddress).toBeUndefined();
  },
);
