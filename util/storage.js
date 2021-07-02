const fs = require("fs");
const { Transform } = require("stream");
const { createHash } = require("crypto");

const Minio = require("minio");

class S3StorageSync
{
  constructor(urlOrData, userId) {
    let url;
    let accessKey;
    let secretKey;

    if (typeof(urlOrData) === "string") {
      url = new URL(urlOrData);
      accessKey = url.username;
      secretKey = url.password;

    } else {
      url = new URL(urlOrData.endpointUrl);
      accessKey = urlOrData.accessKey;
      secretKey = urlOrData.secretKey;
    }

    this.client = new Minio.Client({
      endPoint: url.hostname,
      port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
      useSSL: url.protocol === "https:",
      accessKey,
      secretKey
    });

    this.bucketName = url.pathname.slice(1).split("/")[0];

    this.objectPrefix = url.pathname.slice(this.bucketName.length + 2);

    this.resources = [];

    this.userId = userId;
  }

  async setPublicPolicy() {
    const policy = `\
{
  "Version":"2012-10-17",
  "Statement":[
    {
      "Sid":"PublicRead",
      "Effect":"Allow",
      "Principal": "*",
      "Action":["s3:GetObject","s3:GetObjectVersion"],
      "Resource":["arn:aws:s3:::${this.bucketName}/${this.objectPrefix}*"]
    }
  ]
}`;

    console.log(this.bucketName, policy);

    await this.client.setBucketPolicy(this.bucketName, policy);

  }

  async init() {
    await this.setPublicPolicy();
    this.userBuffer = await this.syncUserLog(this.userId);
    if (!this.userBuffer) {
      this.userBuffer = JSON.stringify({"op": "new-contributor", "id": this.userId, "ts": new Date().getTime()});
    }

    try {
      await this.client.statObject(this.bucketName, this.objectPrefix + "datapackage.json");
    } catch (e) {
      this.userBuffer += "\n" + JSON.stringify({"op": "coll-create", "ts": new Date().getTime()});
      console.log("coll created!");
    }
  }

  async syncUserLog(userId) {
    let stream = null;
  
    try {
      stream = await this.client.getObject(this.bucketName, this.objectPrefix + "contributors/" + userId + ".jsonl");
    } catch (e) {
      console.log("no user log for: " + userId);
      return null;
    }

    const chunks = [];
    let size = 0;

    for await (const chunk of stream) {
      chunks.push(chunk);
      size += chunk.length;
    }

    const userBuffer = new TextDecoder().decode(Buffer.concat(chunks, size));

    console.log(userBuffer);

    for (const line of userBuffer.split("\n")) {
      try {
        const entry = JSON.parse(line);
        if (entry.op === "upload") {
          this.resources.push({path: entry.path, hash: entry.hash, bytes: entry.bytes});
        }
      } catch (e) {
        console.warn(e);
      }
    }

    return userBuffer;
  }

  async readOtherUserLogs() {
    const stream = this.client.listObjectsV2(this.bucketName, this.objectPrefix + "contributors/", true);

    const prefix = this.objectPrefix + "contributors/";
    const currUserLog = prefix + this.userId + ".jsonl";

    for await (const result of stream) {
      if (result.name === currUserLog) {
        console.log("Skipping Our Log");
        continue;
      }

      const userId = result.name.slice(prefix.length).replace(".jsonl", "");
      console.log(`Synching other user log for: ${userId}`);
      await this.syncUserLog(userId);
    }
  }

  async uploadCollWACZ(filename) {
    const ts = new Date().toISOString().replace(/[:TZz.-]/g, "");
    const relFilename = `data/${ts}-${this.userId}.wacz`;

    const origStream = fs.createReadStream(filename);

    const hash = createHash("sha256");
    let size = 0;
    let finalHash;

    const hashTrans = new Transform({
      transform(chunk, encoding, callback) {
        size += chunk.length;
        hash.update(chunk);
        this.push(chunk);
        callback();
      },

      flush(callback) {
        finalHash = "sha256:" + hash.digest("hex");
        callback();
      }
    });

    const fsStream = origStream.pipe(hashTrans);
    const res = await this.client.putObject(this.bucketName, this.objectPrefix + relFilename, fsStream);
    console.log(res);

    const resource = {"path": relFilename, "hash": finalHash, "bytes": size};

    this.resources.push(resource);

    this.userBuffer += "\n" + JSON.stringify({"op": "upload", ...resource});
    console.log(this.userBuffer);

    // update user log
    await this.client.putObject(this.bucketName, this.objectPrefix + "contributors/" + this.userId + ".jsonl", this.userBuffer);

    await this.readOtherUserLogs();

    // update datapackage.json
    await this.updateDataPackage();
  }

  async updateDataPackage() {
    const data = {resources: this.resources};
    const text = JSON.stringify(data, null, 2);
    console.log(text);

    await this.client.putObject(this.bucketName, this.objectPrefix + "datapackage.json", text, null, {"x-amz-acl": "public-read"});
  }
}

module.exports.S3StorageSync = S3StorageSync;
