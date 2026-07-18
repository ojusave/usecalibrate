export const IDENTIFIER_MAX_LENGTH = 128;
export const CODE_MAX_LENGTH = 64;

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

/**
 * Reports whether a value is a bounded machine identifier, never prose.
 */
export function isIdentifier(
  value: unknown,
  maxLength = IDENTIFIER_MAX_LENGTH,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    identifierPattern.test(value)
  );
}

/**
 * Requires an integrator-chosen identifier with a plain-language error.
 */
export function requireIdentifier(
  value: unknown,
  path: string,
  maxLength = IDENTIFIER_MAX_LENGTH,
): string {
  if (!isIdentifier(value, maxLength)) {
    throw new Error(
      `${path} must be a 1-${maxLength} character identifier using letters, numbers, ".", "_", ":", "/", or "-"`,
    );
  }
  return value;
}
