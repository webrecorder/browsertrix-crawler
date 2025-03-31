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
    const { getState, runFlowStep } = Lib;

    const steps = ${formatSteps(script.steps)};

    for (let i = 1; i <= steps.length; i++) {
      const step = steps[i - 1];
      const res = await runFlowStep(step);
      let msg = \`Step \${i} of \${steps.length}: \${step.type} \`;
      switch (res) {
        case 0:
          msg += "- Processed";
          break;

        case 1:
          msg += "- Not Supported";
          break;

        case 2:
          msg += "- Timed Out";
          break;

        case 3:
          msg += "- Errored";
          break;
      }
      yield getState(ctx, msg, "steps");
      if (res === 2) {
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

export async function runFlowStep(page: Page, params: FlowStepParams) {
  //const { type, selectors } = params;

  const timeoutSec = 5;

  try {
    const res = await runStep(page, params as Step, timeoutSec);
    await sleep(2.0);
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

async function runStep(
  page: Page,
  step: Step,
  timeout: number,
): Promise<StepResult> {
  const localFrame = page.mainFrame();

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

    case StepType.Click:
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
      break;

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
