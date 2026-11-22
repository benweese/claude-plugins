/**
 * Generates JSON Schema files from real response bodies.
 *
 * @module createJsonSchema
 */
/**
 * Resolves the file for a schema name. The name comes from test code but still becomes a file
 * path, so it is sanitized: `..` is removed and characters other than letters, digits, `/`,
 * `_` and `-` become `_`.
 *
 * @param schemasDir - the schemas folder
 * @param name - schema name, e.g. `"posts/getPost"`
 * @returns the absolute path, e.g. `<schemasDir>/posts/getPost.schema.json`
 * @throws Error if the name resolves outside `schemasDir`
 */
export declare function schemaFilePath(schemasDir: string, name: string): string;
/**
 * Writes a strict JSON Schema (draft-07) inferred from a response body. Every object gets
 * `additionalProperties: false`, and fields that were null become `["null", "string"]`.
 * Review the file and tighten it by hand (required fields, enums, formats) before committing.
 *
 * Usually called through `validateJsonSchema(name, body, { update: true })` or
 * `UPDATE_SCHEMAS=true`, not directly.
 *
 * @param schemasDir - the schemas folder
 * @param name - schema name, e.g. `"posts/getPost"`
 * @param body - a real response body to infer the schema from
 * @throws Error if the name resolves outside `schemasDir`
 */
export declare function createJsonSchema(schemasDir: string, name: string, body: unknown): Promise<void>;
