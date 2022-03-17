const path = require("path");
const fs = require("fs");
const os = require("os");

class Lock
{
  constructor(dir) {
    this.lockDir = path.join(dir, ".lock");
    this.lockFile = path.join(this.lockDir, "." + os.hostname());
    fs.mkdirSync(this.lockDir, {recursive: true});
    fs.closeSync(fs.openSync(this.lockFile, "a"));
    console.log(`Created lock file ${this.lockFile}`);
  }

  release() {
    try {
      fs.unlinkSync(this.lockFile);
      console.log(`Removed lock file ${this.lockFile}`);
    } catch (e) {
      // ignore remove failure, but see if other locks exist
    }

    try {
      fs.rmdirSync(this.lockDir);
    } catch (e) {
      // true if no such dir, otherwise not released
      return (e.code === "ENOENT");
    }

    console.log("No more locks");
    return true;
  }
}
    


module.exports.Lock = Lock;
