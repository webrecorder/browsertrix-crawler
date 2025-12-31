import { execSync, exec } from "child_process";
import fs from "fs";
import { Redis } from "ioredis";


const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const ACCESS = "ROOT";
const SECRET = "TESTSECRET";

let storageId;

beforeAll(() => {
  execSync("docker network create upload-test-net");
  storageId = execSync(`docker run --rm -d -p 9000:9000 --name s3storage --network=upload-test-net versity/versitygw --port :9000 --access ${ACCESS} --secret ${SECRET} posix /tmp/`, {encoding: "utf-8"});
});


afterAll(async () => {
  //execSync(`docker kill -s SIGINT ${storageId}`);
  //await sleep(5000);
  //execSync("docker network rm upload-test-net");
});

test("run crawl with upload", async () => {

  execSync(`docker exec ${storageId.trim()} mkdir -p /tmp/test-bucket`);

  const child = exec(
    "docker run --rm " + 
    "-e STORE_ENDPOINT_URL=http://s3storage:9000/test-bucket/ " +
    `-e STORE_ACCESS_KEY=${ACCESS} ` +
    `-e STORE_SECRET_KEY=${SECRET} ` +
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
  execSync(`docker run --entrypoint /bin/sh --network=upload-test-net minio/mc -c "mc alias set local http://s3storage:9000 ${ACCESS} ${SECRET} && mc anonymous set download local/test-bucket"`);

  // doesn't work yet, should replace minio eventually
  //execSync(`docker run --network=upload-test-net -e AWS_ACCESS_KEY=${ACCESS} -e AWS_SECRET_KEY=${SECRET} d3fk/s3cmd setacl s3://test-bucket/ --host=http://s3storage:9000 --host-bucket=http://s3storage:9000 --acl-public`);

  // wait for crawler to finish
  await crawlFinished;

  // ensure WACZ exists at the specified filename
  const resp = await fetch(`http://127.0.0.1:9000/test-bucket/prefix/${filename}`);
  expect(resp.status).toBe(200);
});
