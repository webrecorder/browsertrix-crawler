#!/usr/bin/env node

process.once("SIGINT", () => {
  console.log("SIGINT received, exiting");
  process.exit(1);
});

process.once("SIGTERM", () => {
  console.log("SIGTERM received, exiting");
  process.exit(1);
});


const { Crawler } = require("./crawler");

new Crawler().run();

