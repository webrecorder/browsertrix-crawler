import express from "express";
import bodyParser from "body-parser";
import child_process from "child_process";

console.log("In server");
const app = express();
const port = 3000;

app.use(bodyParser.json());

app.post("/crawl", (req, res) => {
  const reqDict = { ...req.body };
  const requiredKeys = ["url", "collection", "id"];
  const missingKeys = requiredKeys.filter((key) => !(key in reqDict));
  if (missingKeys.length === 0) {
    res.status(200).json({info: `${reqDict.url} enqueued to crawl`});
    const args = [
      "--url", reqDict.url,
      "--collection", String(reqDict.collection),
      "--id", String(reqDict.url),
      "--generateWARC",
      "--combineWARC", "true",
      "--w", "3",
      "--scopeType", "page-spa",
      "--waitUntil", "networkidle0",
      "--timeout", "30",
      "--behaviorTimeout", "30"
    ];
    child_process.spawn("crawl", args, {stdio: "inherit"});
  } else {
    res.status(404).json({error: "Ensure that url, collection and id is present as keys in json"});
  }
});


// Start the server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});