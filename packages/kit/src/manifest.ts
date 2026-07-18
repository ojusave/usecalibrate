import { requireIdentifier } from "./value-validation.js";

export interface ManifestStep {
  id: string;
  group: string;
  label?: string;
}

export interface Manifest {
  version: string;
  groups: string[];
  steps: ManifestStep[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates and projects an unknown value into the fields firstmile reads.
 */
export function validateManifest(value: unknown): Manifest {
  if (!isRecord(value)) {
    throw new Error("manifest must be an object");
  }

  const version = requireIdentifier(value.version, "manifest version");

  if (!Array.isArray(value.groups) || value.groups.length === 0) {
    throw new Error("manifest groups must be a non-empty array");
  }
  const groups = value.groups.map((group, index) =>
    requireIdentifier(group, `manifest group at index ${index}`),
  );
  const duplicateGroup = groups.find(
    (group, index) => groups.indexOf(group) !== index,
  );
  if (duplicateGroup !== undefined) {
    throw new Error(`manifest has duplicate group "${duplicateGroup}"`);
  }

  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    throw new Error("manifest steps must be a non-empty array");
  }

  const groupSet = new Set(groups);
  const stepIds = new Set<string>();
  const steps = value.steps.map((candidate, index): ManifestStep => {
    if (!isRecord(candidate)) {
      throw new Error(`manifest step at index ${index} must be an object`);
    }

    const id = requireIdentifier(
      candidate.id,
      `manifest step id at index ${index}`,
    );
    if (stepIds.has(id)) {
      throw new Error(`manifest has duplicate step id "${id}"`);
    }
    stepIds.add(id);

    const group = requireIdentifier(
      candidate.group,
      `manifest step "${id}" group`,
    );
    if (!groupSet.has(group)) {
      throw new Error(
        `manifest step "${id}" references unknown group "${group}"`,
      );
    }

    if (candidate.label !== undefined && typeof candidate.label !== "string") {
      throw new Error(`manifest step "${id}" label must be a string`);
    }

    return candidate.label === undefined
      ? { id, group }
      : { id, group, label: candidate.label };
  });

  return { version, groups, steps };
}

/**
 * Returns manifest indexes used by reducers and snapshots.
 */
export function indexManifest(manifest: Manifest): {
  stepIndexes: ReadonlyMap<string, number>;
  stepGroups: ReadonlyMap<string, string>;
} {
  return {
    stepIndexes: new Map(manifest.steps.map((step, index) => [step.id, index])),
    stepGroups: new Map(manifest.steps.map((step) => [step.id, step.group])),
  };
}
