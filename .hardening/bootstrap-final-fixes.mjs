import {readFile, writeFile} from "node:fs/promises";

const path = "extensions/personalised-post-purchase/src/index.jsx";
const source = await readFile(path, "utf8");
const fixed = source.replace(
  'import React, {useEffect, useState} from "react";',
  'import {useEffect, useState} from "react";',
);
if (fixed === source) throw new Error("Expected extension import was not found.");
await writeFile(path, fixed, "utf8");
