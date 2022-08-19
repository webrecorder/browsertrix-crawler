const SingleBrowserImplementation = require("puppeteer-cluster/dist/concurrency/SingleBrowserImplementation").default;


// ===========================================================================
class ReuseWindowConcurrency extends SingleBrowserImplementation {
  async init() {
    await super.init();

    this.pendingTargets = new Map();
    this.startPage = "about:blank?_browsertrix" + Math.random().toString(36).slice(2);

    this.pages = [];
    this.reuseCount = 25;

    const mainTarget = this.browser.target();
    this.cdp = await mainTarget.createCDPSession();

    this.browser.on("targetcreated", (target) => {
      if (target.url() === this.startPage) {
        this.pendingTargets.set(target._targetId, target);
      }
    });
  }

  async getNewPage() {
    while (true) {
      let targetId;
      try {
        const res = await this.cdp.send("Target.createTarget", {url: this.startPage, newWindow: true});
        targetId = res.targetId;
      } catch (e) {
        console.warn(e);
        return null;
      }

      const target = this.pendingTargets.get(targetId);
      // this shouldn't really happen, but just in case somehow ended up w/o a target, try again
      if (!target) {
        continue;
      }

      this.pendingTargets.delete(targetId);

      return {page: await target.page(), count: 0};
    }
  }

  async createResources() {
    if (this.pages.length) {
      return this.pages.shift();
    }
    return await this.getNewPage();
  }

  async freeResources(resources) {
    if (++resources.count <= this.reuseCount) {
      this.pages.push(resources);
    } else {
      //console.log(`page not reused, ${this.reuseCount} reached`);
      await resources.page.close();
    }
  }
}

module.exports = { ReuseWindowConcurrency };


