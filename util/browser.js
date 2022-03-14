const child_process = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const request = require("request");

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-"));

module.exports.loadProfile = function(profileFilename) {
  if (profileFilename &&
      (profileFilename.startsWith("http:") || profileFilename.startsWith("https:"))) {
    request.get(profileFilename).on("error", (err) => {
      console.error(err);
      throw Error("Unable to load profile: " + profileFilename);
    }).pipe(fs.createWriteStream("/tmp/profile.tar.gz"));

    profileFilename = "/tmp/profile.tar.gz";
  }

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


module.exports.evaluateWithCLI = async (frame, funcString) => {
  const context = await frame.executionContext();

  // from puppeteer _evaluateInternal() but with includeCommandLineAPI: true
  const contextId = context._contextId;
  const expression = funcString + "\n//# sourceURL=__puppeteer_evaluation_script__";

  const { exceptionDetails, result: remoteObject } = await context._client
    .send("Runtime.evaluate", {
      expression,
      contextId,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      includeCommandLineAPI: true,
    });

  if (exceptionDetails) {
    throw new Error(
      "Behavior Evaluation Failed" + exceptionDetails.text
    );
  }

  return remoteObject.value;
};

