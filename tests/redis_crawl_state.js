import child_process from "child_process";

test("ensure crawl run with redis passes", async () => {
  const redis = child_process.spawn(
    "docker run -d --name test-crawl-redis -p 6379:6379 redis",
  );

  child_process.execSync(
    "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url http://www.example.com/ --generateWACZ  --text --collection redis-crawl --redisStoreUrl redis://127.0.0.1:6379 --workers 2",
  );

  redis.kill("SIGINT");
});

// test("check that wacz created is valid", () => {
//   child_process.execSync(
//     "docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler wacz validate --file collections/redis-crawl/redis-crawl.wacz",
//   );
// });
