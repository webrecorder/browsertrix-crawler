import type { CrawlerArgs } from "../src/util/argParser";
import type { PartialDeep } from "type-fest";
import type { BlockRuleDecl } from "../src/util/blockrules";
import { RedisOptions } from "ioredis";

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

let redisStopped = false;

export const markRedisStopped = () => {
  redisStopped = true;
};

export const redisOpts: RedisOptions = {
  //lazyConnect: true,
  maxRetriesPerRequest: null,
  connectTimeout: 30000,
  retryStrategy: (retries: number) => {
    // if redis already stopped, stop retrying
    if (redisStopped) {
      return null;
    }

    // retry 20 times every 1000ms
    if (retries < 20) {
      return 750;
    }
    console.error("Max redis retries reached, failing connection");
    return null;
  },
};
