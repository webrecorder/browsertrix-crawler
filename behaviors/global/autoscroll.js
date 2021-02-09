async function autoScroll() {
  const canScrollMore = () =>
    self.scrollY + self.innerHeight <
    Math.max(
      self.document.body.scrollHeight,
      self.document.body.offsetHeight,
      self.document.documentElement.clientHeight,
      self.document.documentElement.scrollHeight,
      self.document.documentElement.offsetHeight
    );

  const scrollOpts = { top: 250, left: 0, behavior: "auto" };

  while (canScrollMore()) {
    self.scrollBy(scrollOpts);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}


// ===========================================================================
class AutoScrollBehavior
{

  async beforeLoad(page, crawler) {
  }

  async afterLoad(page, crawler) {
    try {
      await Promise.race([page.evaluate(autoscroll), crawler.sleep(30000)]);
    } catch (e) {
      console.warn("Autoscroll Behavior Failed", e);
    }
  }
}

module.exports = AutoScrollBehavior;
