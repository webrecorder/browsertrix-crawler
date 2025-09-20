export class TestBehavior {
  static init() {
    return {
      state: {},
    };
  }

  static get id() {
    return "TestBehavior";
  }

  static isMatch() {
    return window.location.origin === "https://example-com.webrecorder.net";
  }

  async *run(ctx) {
    ctx.log("In Test Behavior!");
    yield ctx.Lib.getState(ctx, "test-stat");
  }
}
