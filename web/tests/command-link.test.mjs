import { expect, test } from "bun:test";

const webRoot = `${import.meta.dir}/..`;
const source = `${import.meta.dir}/fixtures/command-app.bjs`;

function run(command) {
  const result = Bun.spawnSync(command, {
    cwd: webRoot,
    env: process.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed:\n${result.stderr.toString()}`);
  }
}

test("links commands through the checked graph and generated artifacts", async () => {
  const output = Bun.spawnSync(["mktemp", "-d", "/tmp/wake-command-link.XXXXXX"], {
    stderr: "pipe",
    stdout: "pipe",
  }).stdout.toString().trim();
  try {
    run([`${webRoot}/bin/wake-compile`, "--all", source, output]);
    const plan = JSON.parse(await Bun.file(`${output}/app.fram.json`).text());
    expect(plan.entities.map(entity => entity.name)).toEqual([
      "entry",
      "wake.core/command-receipt",
    ]);
    expect(plan.entities[1]).toMatchObject({
      name: "wake.core/command-receipt",
      storageId: "wake/core/entity/command-receipt",
      identity: { field: "id", type: "Digest" },
    });
    expect(plan.commands).toHaveLength(1);
    const command = plan.commands[0];
    expect(command.name).toBe("create-entry");
    expect(command.capabilities[0].capability).toBe("app/cap/create-entry");
    expect(command.input[1].type).toEqual({
      items: { kind: "string" },
      kind: "list",
      maxItems: 8,
      normalizer: "sort-unique",
    });
    expect(command.injections[0].type).toEqual({ kind: "digest" });
    expect(command.receipt.resultFields).toEqual([{
      field: "result-entry",
      name: "id",
      type: { kind: "string" },
    }]);
    expect(JSON.stringify(command)).not.toMatch(/storageId|targetEntity|extensionPort/u);

    const client = await import(`${output}/wake-client.js?test=${Date.now()}`);
    expect(client.normalizeCommandInput("create-entry", {
      id: "entry-c",
      links: ["entry-b", "entry-a", "entry-b"],
    })).toEqual({
      id: "entry-c",
      links: ["entry-a", "entry-b"],
    });
    const application = await Bun.file(`${output}/app.js`).text();
    expect(application).toContain('const wakeFramFieldMeta = Object.assign');
    expect(application).toContain('["entry"]: Object.assign');
    expect(application).toContain('const wakeFramBindings = new Map');
  } finally {
    Bun.spawnSync(["rm", "-rf", "--", output]);
  }
}, 30_000);
