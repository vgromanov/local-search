import { readFileSync, writeFileSync } from "fs";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const versions = JSON.parse(readFileSync("versions.json", "utf8"));

versions[manifest.version] = manifest.minAppVersion;

writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");
