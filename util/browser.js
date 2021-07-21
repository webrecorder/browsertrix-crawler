const child_process = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-"));

module.exports.loadProfile = function(profileFilename) {
  if (profileFilename) {
    child_process.execSync("tar xvfz " + profileFilename, {cwd: profileDir});
  }

  return profileDir;
};

module.exports.saveProfile = function(profileFilename) {
  child_process.execFileSync("tar", ["cvfz", profileFilename, "./"], {cwd: profileDir});
};

module.exports.getBrowserExe = function() {
  const files = [process.env.BROWSER_BIN, "/usr/bin/google-chrome", "/usr/bin/chromium-browser"];
  for (const file of files) {
    if (file && fs.existsSync(file)) {
      return file;
    }
  }

  return null;
};




