import { CDPSession, Protocol } from "puppeteer-core";
import { logger } from "./logger.js";

export class BrowserPage {
  cdp: CDPSession;

  constructor(cdp: CDPSession) {
    this.cdp = cdp;
  }

  async init() {
    //await this.cdp.send("Page.setLifecycleEventsEnabled", {enabled: true});
    //this.cdp.on("Page.lifecycleEvent", (params) => {
    //console.log("lifecycle: " + params.name);
    //});
  }

  async setupServiceWorker(swOpt: string, hasProfile: boolean) {
    switch (swOpt) {
      case "disabled":
        logger.debug("Service Workers: always disabled", {}, "browser");
        await this.cdp.send("Network.setBypassServiceWorker", { bypass: true });
        break;

      case "disabled-if-profile":
        if (hasProfile) {
          logger.debug(
            "Service Workers: disabled since using profile",
            {},
            "browser",
          );
          await this.cdp.send("Network.setBypassServiceWorker", {
            bypass: true,
          });
        }
        break;

      case "enabled":
        await this.cdp.send("Network.setBypassServiceWorker", {
          bypass: false,
        });
        logger.debug("Service Workers: always enabled", {}, "browser");
        break;
    }
  }

  async goto(url: string, events = ["load", "networkIdle"]) {
    const eventsFound: Record<string, boolean> = {};

    for (const event of events) {
      eventsFound[event] = false;
    }

    let resolve: () => void;

    const p = new Promise<void>((r) => (resolve = r));

    const handler = (params: Protocol.Page.LifecycleEventEvent) => {
      console.log("lifecycle: " + params.name);
      if (eventsFound[params.name] === false) {
        eventsFound[params.name] = true;
        // if all events have been found, resolve
        if (
          Object.values(eventsFound).reduce(
            (accum, val) => accum + (val ? 1 : 0),
            0,
          ) === events.length
        ) {
          resolve();
          this.cdp.off("Page.lifecycleEvent", handler);
          this.cdp.send("Page.setLifecycleEventsEnabled", { enabled: false });
        }
      }
    };

    this.cdp.on("Page.lifecycleEvent", handler);

    await this.cdp.send("Page.setLifecycleEventsEnabled", { enabled: true });

    const { errorText } = await this.cdp.send("Page.navigate", { url });
    if (errorText) {
      throw new Error(errorText);
    }

    await p;
  }
}
