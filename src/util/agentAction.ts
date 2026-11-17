import type { Page } from "puppeteer-core";

export type AgentAction = {
  action: "click" | "type" | "select" | "scroll" | "wait" | "done";
  selector: string;
  value: string;
  reason: string;
};

export async function executeAgentAction(
  page: Page,
  action: AgentAction,
): Promise<string> {
  if (!/^control-\d+$/.test(action.selector)) {
    return `invalid control ID: ${action.selector}`;
  }
  const selector = `[data-bx-agent-control="${action.selector}"]`;
  switch (action.action) {
    case "click":
      await page.locator(selector).click();
      return "executed click";
    case "type":
      await page.locator(selector).fill(action.value);
      return "executed fill";
    case "select":
      await page.select(selector, action.value);
      return "executed select";
    default:
      return "no action executed: unsuported type";
  }
  return "end";
}
