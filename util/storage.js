const fs = require("fs");
const fsp = require("fs/promises");

const os = require("os");
const { createHash } = require("crypto");

const fetch = require("node-fetch");
const Minio = require("minio");

const { initRedis } = require("./redis");


// ===========================================================================
class S3StorageSync
{
  constructor(urlOrData, {filename, webhookUrl, userId, crawlId} = {}) {
    let url;
    let accessKey;
    let secretKey;

    if (typeof(urlOrData) === "string") {
      url = new URL(urlOrData);
      accessKey = url.username;
      secretKey = url.password;
      url.username = "";
      url.password = "";
      this.fullPrefix = url.href;

    } else {
      url = new URL(urlOrData.endpointUrl);
      accessKey = urlOrData.accessKey;
      secretKey = urlOrData.secretKey;
      this.fullPrefix = url.href;
    }

    this.client = new Minio.Client({
      endPoint: url.hostname,
      port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
      useSSL: url.protocol === "https:",
      accessKey,
      secretKey,
      partSize: 100*1024*1024
    });

    this.client.enableSHA256 = true;

    this.bucketName = url.pathname.slice(1).split("/")[0];

    this.objectPrefix = url.pathname.slice(this.bucketName.length + 2);

    this.resources = [];

    this.userId = userId;
    this.crawlId = crawlId;
    this.webhookUrl = webhookUrl;

    filename = filename.replace("@ts", new Date().toISOString().replace(/[:TZz.]/g, ""));
    filename = filename.replace("@hostname", os.hostname());
    filename = filename.replace("@id", this.crawlId);

    this.waczFilename = "data/" + filename;
  }

  async uploadCollWACZ(filename, completed = true) {
    await this.client.fPutObject(this.bucketName, this.objectPrefix + this.waczFilename, filename);

    const finalHash = await checksumFile("sha256", filename);

    const size = await getFileSize(filename);
    const resource = {"path": this.waczFilename, "hash": finalHash, "bytes": size};
    console.log(resource);

    if (this.webhookUrl) {
      const body = {
        id: this.crawlId,
        user: this.userId,

        //filename: `s3://${this.bucketName}/${this.objectPrefix}${this.waczFilename}`,
        filename: this.fullPrefix + this.waczFilename,

        hash: resource.hash,
        size: resource.bytes,

        completed
      };

      console.log("Pinging Webhook: " + this.webhookUrl);

      if (this.webhookUrl.startsWith("http://") || this.webhookUrl.startsWith("https://")) {
        await fetch(this.webhookUrl, {method: "POST", body: JSON.stringify(body)});
      } else if (this.webhookUrl.startsWith("redis://")) {
        const parts = this.webhookUrl.split("/");
        if (parts.length !== 5) {
          throw new Error("redis webhook url must be in format: redis://<host>:<port>/<db>/<key>");
        }
        const redis = await initRedis(parts.slice(0, 4).join("/"));
        await redis.rpush(parts[4], JSON.stringify(body));
      }
    }
  }
}

async function getFileSize(filename) {
  const stats = await fsp.stat(filename);
  return stats.size;
}

function checksumFile(hashName, path) {
  return new Promise((resolve, reject) => {
    const hash = createHash(hashName);
    const stream = fs.createReadStream(path);
    stream.on("error", err => reject(err));
    stream.on("data", chunk => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

module.exports.S3StorageSync = S3StorageSync;
module.exports.getFileSize = getFileSize;


