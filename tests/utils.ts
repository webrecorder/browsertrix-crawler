import type { CrawlerArgs } from "../src/util/argParser";
import type { PartialDeep } from "type-fest";
import type { BlockRuleDecl } from "../src/util/blockrules";

export type TestConfig = Omit<PartialDeep<CrawlerArgs>, "blockRules"> & {
  blockRules: BlockRuleDecl[];
};

export const isCI = !!process.env.CI;
export const testIf = (condition: unknown, ...args: Parameters<typeof test>) =>
  condition ? test(...args) : test.skip(...args);
export const doValidate = process.argv.filter((x) =>
  x.startsWith("-validate"),
)[0];

export async function sleep(time: number) {
  await new Promise((resolve) => setTimeout(resolve, time));
}

export type ErrorWithStatus = Error & { status: number };
