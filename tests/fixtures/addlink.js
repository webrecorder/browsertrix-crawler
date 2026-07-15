/* eslint-disable @typescript-eslint/no-unused-vars */
class AddLinkBehavior {
  static init() {
    return {
      state: {},
    };
  }

  static get id() {
    return "AddLinkBehavior";
  }

  static isMatch() {
    return window.location.origin === "https://old.webrecorder.net";
  }

  async *run(ctx) {
    ctx.log("Adding link to domain outside the crawl scope!");
    await ctx.Lib.addLink("https://example-com.webrecorder.net");
  }
}
