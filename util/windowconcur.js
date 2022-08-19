const SingleBrowserImplementation = require("puppeteer-cluster/dist/concurrency/SingleBrowserImplementation").default;


// ===========================================================================
class ReuseWindowConcurrency extends SingleBrowserImplementation {
  async init() {
    await super.init();

    this.pendingTargets = new Map();
    this.startPage = "about:blank?_browsertrix" + Math.random().toString(36).slice(2);

    this.pages = [];
    this.reuseCount = 25;

    this.screencaster = null;

    const mainTarget = this.browser.target();

    this.cdp = await mainTarget.createCDPSession();
    this.sessionId = this.cdp.id();

    this.browser.on("targetcreated", (target) => {
      if (target.url() === this.startPage) {
        this.pendingTargets.set(target._targetId, target);
      }
    });
  }

  setScreencaster(screencaster) {
    this.screencaster = screencaster;
  }

  async repair() {
    if (this.openInstances !== 0 || this.repairing) {
      // already repairing or there are still pages open? wait for start/finish
      await new Promise(resolve => this.waitingForRepairResolvers.push(resolve));
      return;
    }

    this.repairing = true;
    console.debug("Starting repair");

    if (this.screencaster) {
      this.screencaster.endAllTargets();
    }

    try {
      // will probably fail, but just in case the repair was not necessary
      await this.browser.close();
    } catch (e) {
      console.debug("Unable to close browser.");
    }

    try {
      await this.init();
    } catch (err) {
      console.debug("Unable to restart chrome.");
    }
    this.repairRequested = false;
    this.repairing = false;
    this.waitingForRepairResolvers.forEach(resolve => resolve());
    this.waitingForRepairResolvers = [];
  }

  async getNewPage() {
    while (true) {
      let targetId;
      try {
        const res = await this.cdp.send("Target.createTarget", {url: this.startPage, newWindow: true});
        targetId = res.targetId;
      } catch (e) {
        console.warn(e);
        await this.repair();
      }

      const target = this.pendingTargets.get(targetId);
      // this shouldn't really happen, but just in case somehow ended up w/o a target, try again
      if (!target) {
        continue;
      }

      this.pendingTargets.delete(targetId);

      return {page: await target.page(), count: 0, id: this.sessionId};
    }
  }

  async createResources() {
    if (this.pages.length) {
      const res = this.pages.shift();
      if (res.id === this.sessionId) {
        return res;
      } else {
        // page is using stale session (eg. from crashed/previous browser instance), don't attempt to reuse
      }
    }
    return await this.getNewPage();
  }

  async freeResources(resources) {
    // if marked as failed, don't try to reuse
    if (resources.page.__failed) {
      await resources.page.close();
    }
    if (++resources.count > this.reuseCount) {
      await resources.page.close();
    } else {
      this.pages.push(resources);
    }
  }
}

module.exports = { ReuseWindowConcurrency };


