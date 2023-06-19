import express from "express";
import bodyParser from "body-parser";
import child_process from "child_process";
import yaml from "js-yaml";
import fs from "fs";

const app = express();
const port = 3000;

app.use(bodyParser.json());

let crawlProcess = null;
let fixedArgs = createArgsFromYAML();

app.post("/crawl", (req, res) => {
  try {
    const reqDict = {...req.body};
    const requiredKeys = ["url", "collection", "id", "domain", "level"];
    const missingKeys = requiredKeys.filter((key) => !(key in reqDict));
    if (missingKeys.length === 0) {
      const args = [
        "--url", reqDict.url,
        "--domain", reqDict.domain,
        "--level", String(reqDict.level),
        "--collection", String(reqDict.collection),
        "--id", String(reqDict.id)
      ];
      args.push(...fixedArgs);

      crawlProcess = child_process.spawnSync("crawl", args, {stdio: "inherit"});
      res.status(200).json({info: `${reqDict.url} crawl finished`});
    } else {
      res.status(404).json({error: `Ensure that ${requiredKeys.join(". ")} is present as keys in json`});
    }
  } catch (e) {
    res.status(500).json({error: e.message});
  }

});


app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});


// Handle SIGTSTP signal (Ctrl+Z)
process.on("SIGTSTP", () => {
  if (crawlProcess) {
    crawlProcess.kill();
  }
  process.exit(0);
});

function createArgsFromYAML(){
  // Parse the YAML content
  const data = yaml.load(fs.readFileSync("/app/config.yaml", "utf8"));
  let args = [];
  // Iterate through each key-value pair
  Object.entries(data.server).forEach(([key, value]) => {
    args.push(`--${key}`, value);
  });
  return args;
}