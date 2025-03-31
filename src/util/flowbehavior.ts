import crypto from "crypto";
import { Locator, Page } from "puppeteer-core";
import { sleep } from "./timing.js";
import {
  ChangeStep,
  ClickStep,
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

type SingleSiteScript = {
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

enum StepResult {
  Success = 0,
  NotHandled = 1,
  TimedOut = 2,
  OtherError = 3,
  Repeat = 4,
}

export function parseRecorderFlowJson(contents: string): string {
  const flow = JSON.parse(contents);

  const allScripts: SingleSiteScript[] = [];

  let currScript: SingleSiteScript | null = null;

  for (const step of flow.steps) {
    switch (step.type) {
      case "setViewport":
        // ignore
        break;

      case "navigate":
        if (currScript) {
          allScripts.push(currScript);
        }
        currScript = { url: step.url, steps: [] };
        break;

      default:
        currScript?.steps.push(step);
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
  const urlJSON = JSON.stringify(url);

  const suffix = crypto.randomBytes(4).toString("hex");

  return `\
class BehaviorScript_${suffix}
{
  static id = "${url}-${suffix}";

  static isMatch() {
    return window.location.href.startsWith(${urlJSON}) && window === window.top;
  }

  static init() {
    return {};
  }

  async* run(ctx) {
    const { Lib } = ctx;
    const { getState, initFlow, nextFlowStep } = Lib;

    const flowId = await initFlow(${formatSteps(script.steps)});

    while (true) {
      const {done, msg} = await nextFlowStep(flowId);
      yield getState(ctx, msg, "steps");
      if (done) {
        break;
      }
    }
  }
}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatSteps(steps: any[]) {
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
  return JSON.stringify(steps, null, 2);
}

// ============================================================================
class Flow {
  id: number;
  lastId = "";
  recorder: Recorder | null;
  steps: FlowStepParams[];
  repeatSteps = new Map<string, number>();
  currStep = 0;

  timeoutSec = 10;
  pauseSec = 2;

  constructor(id: number, recorder: Recorder | null, steps: FlowStepParams[]) {
    this.id = id;
    this.recorder = recorder;
    this.steps = steps;
    this.currStep = 0;
  }

  async nextFlowStep(page: Page) {
    if (this.currStep >= this.steps.length) {
      return { done: true, msg: "All Steps Done!" };
    }

    const step = this.steps[this.currStep];

    let msg = `${step.type} step - `;

    const res = await this.runFlowStep(page, step);

    this.currStep++;

    switch (res) {
      case StepResult.Success:
        msg += "processed";
        return { done: false, msg };

      case StepResult.Repeat:
        msg += "processed, repeating";
        this.currStep--;
        return { done: false, msg };

      case StepResult.NotHandled:
        msg += "not supported, ignoring";
        return { done: false, msg };

      case StepResult.TimedOut:
        msg += "not found, not stopping";
        return { done: false, msg };

      case StepResult.OtherError:
        msg += "errored, stopping";
        return { done: true, msg };
    }
  }

  async runFlowStep(page: Page, params: FlowStepParams): Promise<StepResult> {
    try {
      const res = await this.runStep(page, params as Step, this.timeoutSec);
      await sleep(this.pauseSec);
      return res;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      if (e.toString().startsWith("TimeoutError")) {
        return StepResult.TimedOut;
      } else {
        logger.warn(e.toString(), { params }, "behavior");
        return StepResult.OtherError;
      }
    }
  }

  private async shouldRepeat(step: ClickStep, activity: Promise<boolean>) {
    if (!this.recorder) {
      return false;
    }

    const id = step.selectors
      .map((x) => selectorToPElementSelector(x))
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

    const fetched = await Promise.race([activity, sleep(this.timeoutSec)]);
    if (!fetched) {
      logger.debug("Flow repeat ended, not found / timed out");
    }

    return fetched;
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
        step.selectors.map((selector) => {
          return localFrame.locator(selectorToPElementSelector(selector));
        }),
      );
    }

    switch (step.type) {
      case StepType.EmulateNetworkConditions:
      case StepType.Navigate:
      case StepType.SetViewport:
      case StepType.Close:
      case StepType.CustomStep:
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
        const p = new Promise<boolean>((resolve) => {
          this.recorder!.once("fetching", () => {
            resolve(true);
          });
        });

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
        if (await this.shouldRepeat(step, p)) {
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
      case StepType.WaitForElement: {
        try {
          //startWaitingForEvents();
          //await waitForElement(step, localFrame, timeout);
          await locator(step).wait();
        } catch (err) {
          if ((err as Error).message === "Timed out") {
            return StepResult.TimedOut;
          } else {
            return StepResult.OtherError;
          }
        }
        break;
      }
      case StepType.WaitForExpression: {
        //startWaitingForEvents();
        await localFrame.waitForFunction(step.expression, {
          timeout,
        });
        break;
      }

      default:
        return StepResult.NotHandled;
    }

    return StepResult.Success;
  }
}

// ============================================================================
let flowCounter = 0;

const flows = new Map<number, Flow>();

// ============================================================================
export async function initFlow(
  steps: FlowStepParams[],
  recorder: Recorder | null,
) {
  const id = flowCounter++;
  logger.debug("Init Flow Called", { id }, "behavior");
  flows.set(id, new Flow(id, recorder, steps));
  return id;
}

// ============================================================================
export async function nextFlowStep(id: number, page: Page) {
  const flow = flows.get(id);
  if (!flow) {
    logger.debug("Flow Not Found", { id }, "behavior");
    return { done: true, msg: "Invalid Flow" };
  }
  logger.debug("Next Flow Step", { id }, "behavior");
  const res = await flow.nextFlowStep(page);
  if (res.done) {
    flows.delete(id);
  }
  return res;
}
