class TestBehavior2
{
  static init() {
    return {
      state: {}
    };
  }

  static get id() {
    return "TestBehavior2";
  }

  static isMatch() {
    return window.location.origin === "https://webrecorder.net";
  }


  async* run(ctx) {
    ctx.log("In Test Behavior 2!");
    yield ctx.Lib.getState(ctx, "test-stat-2");
  }
}
