const fs = require("node:fs");

const path = "live-client.bundle.js.LEGAL.txt";
fs.writeFileSync(path, fs.readFileSync(path, "utf8").replace(/[ \t]+$/gm, ""));
