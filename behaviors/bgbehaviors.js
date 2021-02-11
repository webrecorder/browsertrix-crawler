const AutoPlayBehavior = require("./global/autoplay");

const AutoFetchBehavior = require("./global/autofetcher");

const AutoScrollBehavior = require("./global/autoscroll");


// ===========================================================================
class BackgroundBehaviors
{
  constructor(bgbehaviors) {
    this.doAutoFetch = bgbehaviors.includes("auto-fetch");
    this.doAutoPlay = bgbehaviors.includes("auto-play");
    this.doAutoScroll = bgbehaviors.includes("auto-scroll");
  }

  async setup(page, crawler) {
    const behaviors = [];

    try {
      if (this.doAutoFetch) {
        behaviors.push(new AutoFetchBehavior());
      }

      if (this.doAutoPlay) {
        behaviors.push(new AutoPlayBehavior());
      }

      if (this.doAutoScroll) {
        behaviors.push(new AutoScrollBehavior());
      }

      await Promise.all(behaviors.map(b => b.beforeLoad(page, crawler)));

    } catch (err) {
      console.log(err);
    }

    return () => Promise.all(behaviors.map(b => b.afterLoad(page, crawler)));
  }
}

module.exports = BackgroundBehaviors;

