import child_process from "child_process";
import Redis from "ioredis";


async function sleep(time) {
  await new Promise((resolve) => setTimeout(resolve, time));
}

test("test pushing behavior logs to redis", async () => {
  const child = child_process.exec("docker run -p 36398:6379 -v $PWD/test-crawls:/crawls -v $PWD/tests/custom-behaviors/:/custom-behaviors/ -e CRAWL_ID=behavior-logs-flow-test --rm webrecorder/browsertrix-crawler crawl --debugAccessRedis --url https://webrecorder.net/ --customBehaviors /custom-behaviors/custom-flow.json  --scopeType page --logBehaviorsToRedis --pageExtraDelay 20");

  let crawlFinished = false;

  child.on("exit", function () {
    crawlFinished = true;
  });

  const redis = new Redis("redis://127.0.0.1:36398/0", { lazyConnect: true, retryStrategy: () => null });

  await sleep(3000);

  await redis.connect({ maxRetriesPerRequest: 50 });

  let customLogLineCount = 0;
  let done = false;

  while (!crawlFinished) {
    let res = null;
    try {
       res = await redis.rpop("behavior-logs-flow-test:b");
    } catch (e) {
      break;
    }
    if (!res) {
      await sleep(500);
      continue;
    }
    const json = JSON.parse(res);
    if (json.context === "behaviorScriptCustom") {
      customLogLineCount++;
    }
    if (json.message === "All Steps Done!") {
      done = true;
    }
  }

  expect(customLogLineCount).toEqual(4);
  expect(done).toBe(true);
});
