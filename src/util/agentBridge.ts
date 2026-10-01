import { request } from "undici";
import { AgentAction } from "./agentAction";
import { Page } from "puppeteer-core";

export type AgentResponse =
  | {
      status: "ok";
      actions: AgentAction[];
    }
  | {
      status: "error";
      error: string;
    };

export type BrowserObservation = {
  url: string;
  controls: string;
};
export async function agentBridge(
  page: Page,
  browserObservation: BrowserObservation,
  url: string,
): Promise<AgentResponse> {
  const accessibilityTree = await page.accessibility.snapshot({
    interestingOnly: true,
    includeIframes: true,
  });

  const observation = {
    ...browserObservation,
    accessibilityTree,
  };
  const response = await request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      title: "observation",
      content: observation,
    }),
  });
  if (response.statusCode !== 200) {
    return {
      status: "error",
      error: `Listener returned HTTP ${response.statusCode}`,
    };
  }
  return (await response.body.json()) as AgentResponse;
}
