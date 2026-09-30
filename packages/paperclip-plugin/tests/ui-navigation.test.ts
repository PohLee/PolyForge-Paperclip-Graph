import assert from "node:assert/strict";
import test from "node:test";

import { polyForgePageHref } from "../src/ui/routes.js";

test("PolyForge sidebar links to the active plugin instance page route", () => {
  const pluginId = "acde935c-fb4e-4aca-b5e4-8e496d3bbb48";

  assert.equal(polyForgePageHref(pluginId), `/plugins/${pluginId}#health`);
});

test("PolyForge page route safely encodes plugin instance IDs", () => {
  assert.equal(polyForgePageHref("plugin id"), "/plugins/plugin%20id#health");
});
