import { execSync, exec, spawnSync } from "child_process";
import fs from "fs";
import { Redis } from "ioredis";


const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

let minioId;

beforeAll(() => {
  execSync("docker network create upload-test-net");
  minioId = execSync("docker run --rm -d -p 9000:9000 -p 9001:9001 --name minio --network=upload-test-net minio/minio server /data --console-address ':9001'", {encoding: "utf-8"});
});


afterAll(async () => {
  execSync(`docker kill -s SIGINT ${minioId}`);
  spawnSync(`docker wait ${minioId}`);
  execSync("docker network rm upload-test-net");
});

test("run crawl with upload", async () => {

  execSync(`docker exec ${minioId.trim()} mc mb /data/test-bucket`);

  const child = exec(
    "docker run --rm " + 
    "-e STORE_ENDPOINT_URL=http://minio:9000/test-bucket/ " +
    "-e STORE_ACCESS_KEY=minioadmin " + 
    "-e STORE_SECRET_KEY=minioadmin " + 
    "-e STORE_PATH=prefix/ " +
    "--network=upload-test-net " +
    "-p 36390:6379 -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --url https://old.webrecorder.net/ --limit 2 --collection upload-test --crawlId upload-test --writePagesToRedis --debugAccessRedis --generateWACZ",
  );

  let resolve = null;
  const crawlFinished = new Promise(r => resolve = r);

  // detect crawler exit
  let crawler_exited = false;
  child.on("exit", function () {
    crawler_exited = true;
    resolve();
  });

  const redis = new Redis("redis://127.0.0.1:36390/0", { lazyConnect: true, retryStrategy: () => null });

  await sleep(3000);

  await redis.connect({ maxRetriesPerRequest: 50 });

  let filename;

  while (!crawler_exited) {
    const res = await redis.lpop("upload-test:pages");
    if (!res) {
      await sleep(100);
      continue;
    }
    const json = JSON.parse(res);
    expect(json).toHaveProperty("id");
    expect(json).toHaveProperty("url");
    expect(json).toHaveProperty("ts");
    expect(json).toHaveProperty("title");
    expect(json).toHaveProperty("loadState");
    expect(json).toHaveProperty("filename");
    expect(json).toHaveProperty("depth");
    expect(json).toHaveProperty("seed");
    expect(json).toHaveProperty("favIconUrl");
    filename = json.filename;
    break;
  }

  // ensure bucket is public
  execSync(`docker exec ${minioId.trim()} mc alias set local http://127.0.0.1:9000 minioadmin minioadmin`);
  execSync(`docker exec ${minioId.trim()} mc anonymous set download local/test-bucket`);

  // wait for crawler to finish
  await crawlFinished;

  // ensure WACZ exists at the specified filename
  const resp = await fetch(`http://127.0.0.1:9000/test-bucket/prefix/${filename}`);
  expect(resp.status).toBe(200);
});
