import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const skillDirectory = resolve("packages/kit/skills/install-calibrate");
const skillFile = resolve(skillDirectory, "SKILL.md");

describe("install-calibrate Agent Skill", () => {
  it("matches the Agent Skills directory and frontmatter contract", () => {
    const content = readFileSync(skillFile, "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(content)?.[1];
    expect(frontmatter).toBeDefined();
    const name = /^name:\s*([^\n]+)$/m.exec(frontmatter ?? "")?.[1]?.trim();
    const description = /^description:\s*([^\n]+)$/m.exec(frontmatter ?? "")?.[1]?.trim();
    expect(name).toBe("install-calibrate");
    expect(name).toBe(basename(dirname(skillFile)));
    expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(description?.length).toBeGreaterThan(1);
    expect(description?.length).toBeLessThanOrEqual(1_024);
    expect(content.split("\n").length).toBeLessThan(500);
  });

  it("ships progressive references and Codex UI metadata", () => {
    const content = readFileSync(skillFile, "utf8");
    expect(content).toContain("references/cli.md");
    expect(existsSync(resolve(skillDirectory, "references/cli.md"))).toBe(true);
    const metadata = readFileSync(resolve(skillDirectory, "agents/openai.yaml"), "utf8");
    expect(metadata).toContain('display_name: "Install Calibrate"');
    expect(metadata).toContain("$install-calibrate");
  });
});
