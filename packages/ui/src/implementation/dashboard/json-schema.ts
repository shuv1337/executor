/** Small readers shared by the tool schema viewer, the tool input form and the tool runner. */

export type JsonSchema = { readonly [key: string]: unknown };

/** A schema node: any plain object. Booleans and arrays are not walked. */
export const isSchema = (value: unknown): value is JsonSchema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A non-empty string keyword, such as a description. */
export const text = (value: unknown) =>
  typeof value === "string" && value !== "" ? value : undefined;

/** A keyword value as a person reads it: strings as-is, everything else as JSON. */
export const display = (value: unknown) =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
