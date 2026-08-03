// The containment claim is a documented property, so it is tested where it is made. agentdeck's
// own repository is on the compose mount list, which makes the files the HOST executes -
// Dockerfile, docker-compose.yml, the package.json scripts, eslint.config.mjs - writable by any
// agent in the container. README and plan 005 both state a boundary ("damages a container rather
// than the Mac"); these tests fail if that self-mount consequence stops being stated alongside it.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

const repoRoot = new URL("..", import.meta.url);

const readDoc = async (name: string): Promise<string> =>
  await readFile(new URL(name, repoRoot), "utf8");

const hostExecutedFiles = ["Dockerfile", "docker-compose.yml", "package.json", "eslint.config.mjs"];

void describe("the self-mount consequence is documented where the containment claim is made", () => {
  void test("compose still mounts agentdeck into its own container", async () => {
    // The premise of the other assertions. If this mount ever goes away, they can go too.
    const compose = await readDoc("docker-compose.yml");
    assert.match(compose, /soya-miyoshi\/agentdeck:\/workspace\/agentdeck/);
  });

  void test("the README says the host executes agent-writable files from this repo", async () => {
    const readme = await readDoc("README.md");
    for (const file of hostExecutedFiles) {
      assert.ok(readme.includes(file), `README does not name ${file} as agent-writable`);
    }
    assert.match(readme, /agent-writable/);
    assert.match(readme, /docker compose up --build/);
  });

  void test("the README makes the container the documented place to run the toolchain", async () => {
    const readme = await readDoc("README.md");
    const toolchain = readme.slice(readme.indexOf("## Toolchain"));
    assert.ok(toolchain.length > 0, "README has no Toolchain section");
    assert.match(toolchain, /docker compose exec -T app/);
    assert.match(toolchain, /git status/);
    assert.match(toolchain, /git diff/);
  });

  void test("plan 005 states it in what containment actually buys", async () => {
    const plan = await readDoc("plans/005-containment.md");
    const start = plan.indexOf("## What containment actually buys");
    assert.ok(start >= 0, "plan 005 has no `What containment actually buys` section");
    const section = plan.slice(start, plan.indexOf("\n## ", start + 1));
    for (const file of hostExecutedFiles) {
      assert.ok(section.includes(file), `plan 005 does not name ${file} as agent-writable`);
    }
    assert.match(section, /docker\.sock/);
  });
});
