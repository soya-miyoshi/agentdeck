// The containment claim is a documented property, so it is tested where it is made. agentdeck's
// own repository is on the compose mount list, which makes the files the HOST executes -
// Dockerfile, docker-compose.yml, the package.json scripts, eslint.config.mjs, and the
// node_modules and .pnpm-store trees git cannot see - writable by any
// agent in the container. README and plan 005 both state a boundary ("damages a container rather
// than the Mac"); these tests fail if that self-mount consequence stops being stated alongside it.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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
    assert.match(toolchain, /docker compose exec -T -w \/workspace\/agentdeck app/);
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

// The naming of the four files above is documentation, and documentation was the whole control.
// These assertions are about the structure instead, because `git status` cannot see either of the
// two agent-writable trees the host executes, so no amount of prose makes reviewing them work.
void describe("the host-executed trees git cannot see are off the bind mount", () => {
  for (const path of ["node_modules", ".pnpm-store"]) {
    void test(`compose layers a container-local volume over ${path}`, async () => {
      const compose = await readDoc("docker-compose.yml");
      assert.match(
        compose,
        new RegExp(
          `\\n\\s+- agentdeck-[a-z-]+:/workspace/agentdeck/${path.replace(".", "\\.")}\\b`,
        ),
        `${path} is still the host's, and it is gitignored so review cannot cover it`,
      );
    });

    void test(`${path} is gitignored, which is why the volume is the control`, async () => {
      const ignored = await readDoc(".gitignore");
      assert.match(ignored, new RegExp(`^${path.replace(".", "\\.")}$`, "m"));
    });
  }

  void test("both trees are named as agent-writable where the claim is made", async () => {
    const readme = await readDoc("README.md");
    const plan = await readDoc("plans/005-containment.md");
    for (const doc of [readme, plan]) {
      assert.match(doc, /node_modules/);
      assert.match(doc, /\.pnpm-store/);
    }
  });
});

void describe("the user's bearer token is not inside a bind mount", () => {
  void test("it is a container-local path, and .gitignore no longer puts it at the repo root", async () => {
    // The repo root IS the bind mount every session can read, and every session runs as the uid
    // the server runs as, so mode 0600 separates nothing. Placement is the only control left.
    const ignored = await readDoc(".gitignore");
    assert.doesNotMatch(
      ignored,
      /^\.agentdeck-token$/m,
      ".agentdeck-token at the repo root is inside the mount every agent session can read",
    );
    const compose = await readDoc("docker-compose.yml");
    assert.match(compose, /AGENTDECK_TOKEN_FILE: \/var\/lib\/agentdeck\/token/);
    assert.match(compose, /\n\s+- agentdeck-state:\/var\/lib\/agentdeck\b/);
  });

  void test("plan 005 lists the token in the blast radius with the same-uid caveat", async () => {
    const plan = await readDoc("plans/005-containment.md");
    const start = plan.indexOf("## What containment actually buys");
    const section = plan.slice(start, plan.indexOf("\n## ", start + 1));
    assert.match(section, /AGENTDECK_TOKEN_FILE/);
    assert.match(section, /distinct uid/);
  });
});

// Asserting the README mentions a command is not evidence the command runs; that is the failure
// the toolchain suite exists to prevent, and the containment control deserves the same treatment.
void describe("the documented in-container command actually runs", () => {
  const containerUp = ((): boolean => {
    try {
      const out = execFileSync(
        "docker",
        ["compose", "ps", "--status=running", "--format", "{{.Service}}"],
        {
          cwd: fileURLToPath(repoRoot),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      return out.includes("app");
    } catch {
      return false;
    }
  })();

  void test(
    "pnpm exists in the image at the documented working directory",
    { skip: !containerUp },
    () => {
      const out = execFileSync(
        "docker",
        ["compose", "exec", "-T", "-w", "/workspace/agentdeck", "app", "pnpm", "--version"],
        { cwd: fileURLToPath(repoRoot), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      assert.match(out.trim(), /^9\./);
    },
  );

  void test("the README documents the command with its working directory", async () => {
    const readme = await readDoc("README.md");
    assert.match(readme, /docker compose exec -T -w \/workspace\/agentdeck app pnpm lint/);
  });
});
