import crypto from "crypto";
import { CDPSession, Locator, Page } from "puppeteer-core";
import { sleep } from "./timing.js";
import {
  ChangeStep,
  ClickStep,
  CustomStep,
  DoubleClickStep,
  HoverStep,
  ScrollElementStep,
  type Step,
  StepType,
  WaitForElementStep,
  mouseButtonMap,
  selectorToPElementSelector,
} from "@puppeteer/replay";
import { logger } from "./logger.js";
import { Recorder } from "./recorder.js";
import { deepStrictEqual } from "assert";
import { basename } from "path";
import { RedisCrawlState } from "./state.js";

type SingleSiteScript = {
  id: string;
  url: string;
  steps: {
    type: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params: any;
  }[];
};

type FlowStepParams = {
  type: StepType;
  target: string;
  selectors: string[][];
  offsetY?: number;
  offsetX?: number;
};

type FlowCommand = {
  id: string;
  steps: FlowStepParams[];
};

enum StepResult {
  Success = 0,
  NotHandled = 1,
  TimedOut = 2,
  OtherError = 3,
  Repeat = 4,
  NotFound = 5,
  Done = 6,
}

export function parseRecorderFlowJson(
  contents: string,
  source: string,
): string {
  const flow = JSON.parse(contents);

  const allScripts: SingleSiteScript[] = [];

  let currScript: SingleSiteScript | null = null;

  let counter = 0;

  for (const step of flow.steps) {
    switch (step.type) {
      case "setViewport":
        // ignore
        break;

      case "navigate":
        if (currScript) {
          allScripts.push(currScript);
        }
        counter += 1;
        currScript = {
          url: step.url,
          steps: [],
          id: source + (counter > 1 ? "_" + counter : ""),
        };
        break;

      default:
        if (!currScript) {
          currScript = { url: "", id: source, steps: [] };
        }
        currScript.steps.push(step);
    }
  }

  if (currScript) {
    allScripts.push(currScript);
  }

  let content = "";

  for (const script of allScripts) {
    content += formatScript(script);
  }

  return content;
}

function formatScript(script: SingleSiteScript) {
  const url = script.url;
  const urlJSON = url ? JSON.stringify(url) : "";

  const id = script.id;
  const suffix =
    basename(id).replace(/[^\w]/g, "_") +
    "_" +
    crypto.randomBytes(4).toString("hex");

  return `\
class BehaviorScript_${suffix}
{
  static id = "${id}";

  static isMatch() {
    return ${
      urlJSON ? `window.location.href.startsWith(${urlJSON}) &&` : ""
    } window === window.top;
  }

  static init() {
    return {};
  }

  async* run(ctx) {
    const { Lib } = ctx;
    const { getState, initFlow, nextFlowStep } = Lib;

    const flowId = await initFlow(${formatSteps(id, script.steps)});

    let steps = 0;

    while (true) {
      const {done, state} = await nextFlowStep(flowId);
      yield {steps, ...state};
      steps++;
      if (done) {
        break;
      }
    }
  }
}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatSteps(id: string, steps: any[]) {
  for (const step of steps) {
    if (step.selectors) {
      try {
        step.selectors = step.selectors.map((x: string) =>
          selectorToPElementSelector(x),
        );
      } catch (_) {
        //ignore
      }
    }
  }
  const resp = { id, steps };
  return JSON.stringify(resp, null, 2);
}

// ============================================================================
class Flow {
  lastId = "";
  recorder: Recorder | null;
  cdp: CDPSession;
  steps: FlowStepParams[];
  repeatSteps = new Map<string, number>();
  currStep = 0;
  count = 0;
  state: RedisCrawlState;

  timeoutSec = 5;
  pauseSec = 0.5;
  flowId: string;

  runOnce = false;
  runOncePercentDone = 1.0;

  notFoundCount = 0;

  constructor(
    id: string,
    recorder: Recorder | null,
    cdp: CDPSession,
    steps: FlowStepParams[],
    state: RedisCrawlState,
  ) {
    this.recorder = recorder;
    this.cdp = cdp;
    this.steps = steps;
    this.currStep = 0;
    this.count = 0;
    this.state = state;
    this.flowId = id;
  }

  async nextFlowStep(page: Page) {
    if (this.currStep >= this.steps.length) {
      return { done: true, msg: "All Steps Done!" };
    }

    const step = this.steps[this.currStep];

    let msg = `flow step "${step.type}" - `;

    const res = await this.runFlowStep(page, step);

    this.currStep++;
    let done = false;

    switch (res) {
      case StepResult.Success:
        msg += "processed";
        break;

      case StepResult.Repeat:
        msg += "processed, repeating";
        this.currStep--;
        break;

      case StepResult.NotHandled:
        msg += "not supported, ignoring";
        break;

      case StepResult.NotFound:
        msg += "not found, stopping";
        done = true;
        break;

      case StepResult.Done:
        msg += "processed, done";
        done = true;
        break;

      case StepResult.TimedOut:
        msg += "not found, not stopping";
        break;

      case StepResult.OtherError:
        msg += "errored, stopping";
        done = true;
        break;
    }

    //logger.info(msg, { ...step, count: this.count }, "behaviorScript");
    if (done) {
      await this.checkRunOnce();
    }
    return { state: { msg, ...step }, done };
  }

  async runFlowStep(page: Page, params: FlowStepParams): Promise<StepResult> {
    try {
      const res = await this.runStep(page, params as Step, this.timeoutSec);
      await sleep(this.pauseSec);
      this.notFoundCount = 0;
      return res;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      if (e.toString().startsWith("TimeoutError")) {
        this.notFoundCount++;
        return this.notFoundCount >= 4
          ? StepResult.NotFound
          : StepResult.TimedOut;
      } else {
        logger.warn(e.toString(), { params }, "behavior");
        return StepResult.OtherError;
      }
    }
  }

  private async shouldRepeat(
    step: ClickStep,
    activity: Promise<boolean>,
    page: Page,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    snap: any,
  ) {
    if (!this.recorder) {
      return false;
    }

    const id = step.selectors
      .map((x: string[] | string) => selectorToPElementSelector(x))
      .join("|");
    // if (id !== this.lastId) {
    //   //this.repeatSteps.delete(this.lastId);
    // }
    const count = (this.repeatSteps.get(id) || 0) + 1;
    this.repeatSteps.set(id, count);
    this.lastId = id;
    if (count < 3) {
      return false;
    }

    let changed = await Promise.race([activity, sleep(this.timeoutSec)]);

    if (!changed) {
      const newSnap = await this.getSnap();
      changed = !this.deepEqual(snap, newSnap);
      logger.debug("Flow behavior page change check", { changed }, "behavior");
    }

    if (!changed) {
      logger.debug(
        "Flow Behavior repeat ended, not found / timed out",
        "behavior",
      );
    } else {
      await page.waitForNetworkIdle();
    }

    return changed;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deepEqual(a: any, b: any) {
    try {
      deepStrictEqual(a, b);
      return true;
    } catch (_) {
      return false;
    }
  }

  private async runStep(
    page: Page,
    step: Step,
    timeout: number,
  ): Promise<StepResult> {
    const localFrame =
      step.target === "main" || !step.target
        ? page.mainFrame()
        : await page.waitForFrame(step.target, { timeout });

    function locator(
      step:
        | DoubleClickStep
        | ClickStep
        | ChangeStep
        | ScrollElementStep
        | HoverStep
        | WaitForElementStep,
    ) {
      return Locator.race(
        step.selectors.map((selector: string[] | string) => {
          return localFrame.locator(selectorToPElementSelector(selector));
        }),
      );
    }

    switch (step.type) {
      case StepType.EmulateNetworkConditions:
      case StepType.Navigate:
      case StepType.SetViewport:
      case StepType.Close:
        return StepResult.NotHandled;

      case StepType.DoubleClick:
        await locator(step)
          .setTimeout(timeout * 1000)
          //.on('action', () => startWaitingForEvents())
          .click({
            count: 2,
            button: step.button && mouseButtonMap.get(step.button),
            delay: step.duration,
            offset: {
              x: step.offsetX,
              y: step.offsetY,
            },
          });
        break;

      case StepType.Click: {
        // await for new network requests
        const activity = new Promise<boolean>((resolve) => {
          this.recorder!.once("fetching", () => {
            resolve(true);
          });
        });

        const snap = await this.getSnap();

        await locator(step)
          .setTimeout(timeout * 1000)
          //.on('action', () => startWaitingForEvents())
          .click({
            delay: step.duration,
            button: step.button && mouseButtonMap.get(step.button),
            offset: {
              x: step.offsetX,
              y: step.offsetY,
            },
          });
        if (await this.shouldRepeat(step, activity, page, snap)) {
          return StepResult.Repeat;
        }
        break;
      }

      case StepType.Hover:
        await locator(step)
          .setTimeout(timeout * 1000)
          //.on('action', () => startWaitingForEvents())
          .hover();
        break;

      case StepType.KeyDown:
        await page.keyboard.down(step.key);
        await sleep(0.1);
        break;

      case StepType.KeyUp:
        await page.keyboard.up(step.key);
        await sleep(0.1);
        break;

      case StepType.Change:
        await locator(step)
          //.on('action', () => startWaitingForEvents())
          .setTimeout(timeout * 1000)
          .fill(step.value);
        break;

      case StepType.Scroll: {
        if ("selectors" in step) {
          await locator(step)
            //.on('action', () => startWaitingForEvents())
            .setTimeout(timeout * 1000)
            .scroll({
              scrollLeft: step.x || 0,
              scrollTop: step.y || 0,
            });
        } else {
          //startWaitingForEvents();
          await localFrame.evaluate(
            (x, y) => {
              /* c8 ignore start */
              window.scroll(x, y);
              /* c8 ignore stop */
            },
            step.x || 0,
            step.y || 0,
          );
        }
        break;
      }
      case StepType.WaitForElement:
        await locator(step).wait();
        break;

      case StepType.WaitForExpression: {
        //startWaitingForEvents();
        await localFrame.waitForFunction(step.expression, {
          timeout,
        });
        break;
      }

      case StepType.CustomStep:
        return await this.handleCustomStep(step);

      default:
        return StepResult.NotHandled;
    }

    return StepResult.Success;
  }

  async getSnap() {
    return await this.cdp.send("DOMSnapshot.captureSnapshot", {
      computedStyles: [],
    });
  }

  async handleCustomStep(step: CustomStep) {
    const id = this.flowId;
    switch (step.name) {
      case "runOncePerCrawl":
        if (await this.state.isInUserSet(id)) {
          logger.info(
            "Skipping behavior, already ran for crawl",
            { id },
            "behavior",
          );
          return StepResult.Done;
        }
        logger.info("Behavior will run once if completed", { id }, "behavior");
        this.runOnce = true;

        this.runOncePercentDone =
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ((step.parameters || {}) as any).percentDone ?? 0.5;
        return StepResult.Success;

      default:
        return StepResult.NotHandled;
    }
  }

  async checkRunOnce() {
    if (!this.runOnce) {
      return;
    }

    const id = this.flowId;

    const minSteps = this.steps.length * this.runOncePercentDone;

    if (this.currStep >= minSteps) {
      const actualPercentDone = this.currStep / this.steps.length;
      await this.state.addToUserSet(id);
      logger.info(
        "Flow Behavior ran once per crawl to % done, will not run again",
        {
          id,
          currStep: this.currStep,
          total: this.steps.length,
          minPercentDone: this.runOncePercentDone,
          actualPercentDone,
          minSteps,
        },
        "behavior",
      );
    }
  }
}

// ============================================================================

const flows = new Map<string, Flow>();

// ============================================================================
export async function initFlow(
  { id, steps }: FlowCommand,
  recorder: Recorder | null,
  cdp: CDPSession,
  state: RedisCrawlState,
) {
  logger.debug("Init Flow Behavior Called", { id }, "behavior");
  flows.set(id, new Flow(id, recorder, cdp, steps, state));
  return id;
}

// ============================================================================
export async function nextFlowStep(id: string, page: Page) {
  const flow = flows.get(id);
  if (!flow) {
    logger.error("Flow Behavior Not Found", { id }, "behavior");
    return { done: true, msg: "Invalid Flow" };
  }
  const res = await flow.nextFlowStep(page);
  if (res.done) {
    flows.delete(id);
  }
  return res;
}
