const child_process = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const request = require("request");

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-"));

module.exports.loadProfile = async function(profileFilename) {
  if (profileFilename &&
      (profileFilename.startsWith("http:") || profileFilename.startsWith("https:"))) {

    const targetFilename = "/tmp/profile.tar.gz";

    console.log(`Downloading ${profileFilename} to ${targetFilename}`);

    const p = new Promise((resolve, reject) => {
      request.get(profileFilename).
        on("error", (err) => reject(err)).
        pipe(fs.createWriteStream(targetFilename)).
        on("finish", () => resolve());
    });

    await p;
      
    profileFilename = targetFilename;
  }

  if (profileFilename) {
    try {
      child_process.execSync("tar xvfz " + profileFilename, {cwd: profileDir});
    } catch (e) {
      console.error(`Profile filename ${profileFilename} not a valid tar.gz`);
    }
  }

  return profileDir;
};

module.exports.saveProfile = function(profileFilename) {
  child_process.execFileSync("tar", ["cvfz", profileFilename, "./"], {cwd: profileDir});
};

function getBrowserExe() {
  const files = [process.env.BROWSER_BIN, "/usr/bin/google-chrome", "/usr/bin/chromium-browser"];
  for (const file of files) {
    if (file && fs.existsSync(file)) {
      return file;
    }
  }

  return null;
}


module.exports.getBrowserExe = getBrowserExe;


function getDefaultUA() {
  let version = process.env.BROWSER_VERSION;

  try {
    version = child_process.execFileSync(getBrowserExe(), ["--version"], {encoding: "utf8"});
    version = version.match(/[\d.]+/)[0];
  } catch(e) {
    console.error(e);
  }

  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}


module.exports.getDefaultUA = getDefaultUA;


module.exports.chromeArgs = (proxy, userAgent=null, extraArgs=[]) => {
  // Chrome Flags, including proxy server
  const args = [
    ...(process.env.CHROME_FLAGS ?? "").split(" ").filter(Boolean),
    "--no-xshm", // needed for Chrome >80 (check if puppeteer adds automatically)
    "--no-sandbox",
    "--disable-background-media-suspend",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-features=Translate,LazyFrameLoading,IsolateOrigins,site-per-process",
    "--disable-popup-blocking",
    "--disable-backgrounding-occluded-windows",
    `--user-agent=${userAgent || getDefaultUA()}`,
    ...extraArgs,
  ];

  if (proxy) {
    args.push(`--proxy-server=http://${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`);
  }

  return args;
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


module.exports.sleep = async (time) => {
  return new Promise(resolve => setTimeout(resolve, time));
};





