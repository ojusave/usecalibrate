import { describe, expect, it } from "vitest";
import { validateManifest } from "../src/manifest.js";

describe("validateManifest", () => {
  it("returns only the kit-owned manifest fields", () => {
    const manifest = validateManifest({
      version: "2026-07",
      groups: ["signup"],
      ignoredAtRoot: true,
      steps: [
        {
          id: "email",
          group: "signup",
          label: "Email",
          component: "host-owned",
        },
      ],
    });

    expect(manifest).toEqual({
      version: "2026-07",
      groups: ["signup"],
      steps: [{ id: "email", group: "signup", label: "Email" }],
    });
  });

  it.each([
    [{ version: "v1", groups: [], steps: [{}] }, "groups must be a non-empty array"],
    [{ version: "v1", groups: ["g"], steps: [] }, "steps must be a non-empty array"],
    [
      {
        version: "v1",
        groups: ["g"],
        steps: [
          { id: "same", group: "g" },
          { id: "same", group: "g" },
        ],
      },
      'duplicate step id "same"',
    ],
    [
      {
        version: "v1",
        groups: ["known"],
        steps: [{ id: "step", group: "missing" }],
      },
      'references unknown group "missing"',
    ],
    [
      {
        version: "v1",
        groups: ["first", "empty"],
        steps: [{ id: "step", group: "first" }],
      },
      'group "empty" has no steps',
    ],
    [
      {
        version: "v1",
        groups: ["first", "second"],
        steps: [
          { id: "later", group: "second" },
          { id: "earlier", group: "first" },
        ],
      },
      "steps must follow the declared group order",
    ],
  ])("rejects invalid input with a clear message", (value, message) => {
    expect(() => validateManifest(value)).toThrow(message);
  });

  it("rejects malformed required fields", () => {
    expect(() => validateManifest(null)).toThrow("manifest must be an object");
    expect(() =>
      validateManifest({
        version: "",
        groups: ["g"],
        steps: [{ id: "s", group: "g" }],
      }),
    ).toThrow(
      'manifest version must be a 1-128 character identifier using letters, numbers, ".", "_", ":", "/", or "-"',
    );
    expect(() =>
      validateManifest({
        version: "v1",
        groups: ["g"],
        steps: [{ id: "s", group: "g", label: 1 }],
      }),
    ).toThrow('manifest step "s" label must be a string');
  });

  it("allows labels but rejects prose and unsafe identifier characters", () => {
    expect(() =>
      validateManifest({
        version: "release notes",
        groups: ["g"],
        steps: [{ id: "s", group: "g", label: "Human-readable label" }],
      }),
    ).toThrow("manifest version must be a 1-128 character identifier");
    expect(() =>
      validateManifest({
        version: "v1",
        groups: ["g"],
        steps: [{ id: "email<script>", group: "g" }],
      }),
    ).toThrow("manifest step id at index 0 must be a 1-128 character identifier");
  });
});
