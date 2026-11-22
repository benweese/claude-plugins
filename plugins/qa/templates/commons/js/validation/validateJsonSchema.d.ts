/**
 * JSON Schema validation for API responses.
 *
 * Schemas are files named `<schemasDir>/<name>.schema.json`, where the name can include
 * folders: `"posts/getPost"` → `schemas/posts/getPost.schema.json`. `schemasDir` defaults to
 * `<cwd>/schemas`; set it once with {@link configureSchemas}.
 *
 * @module validateJsonSchema
 */
import { type DateOptions } from "./validateDates.js";
/** Settings for {@link configureSchemas}. */
export interface SchemaSettings {
    /** Absolute path to the schemas folder. */
    schemasDir?: string;
    /** Passed to `validateDatesInBody` on every validation, e.g. a non-ISO date format. */
    dateOptions?: DateOptions;
}
/**
 * Sets where schemas live and how dates are checked. Call it once, from the test repo's config.
 * Clears the cache of compiled schemas.
 *
 * @param settings - see {@link SchemaSettings}; omitted settings keep their current value
 *
 * @example
 * configureSchemas({ schemasDir: path.join(root, "schemas") });
 */
export declare function configureSchemas({ schemasDir, dateOptions }?: SchemaSettings): void;
/** Settings for {@link validateJsonSchema}. */
export interface ValidateOptions {
    /** Generate the schema from this body first. For new endpoints only; never commit it. Default `false`. */
    update?: boolean;
    /** Also check every date-like field. Default `true`. */
    checkDates?: boolean;
}
/**
 * Asserts (soft) that a body matches its schema, and that every date-like field holds a valid
 * date. The failure lists every mismatch, one line each, e.g. `body.items[0].price: must be
 * number, got "12.50"` or `body: unexpected field "extra"`.
 *
 * For a new endpoint, run once with `{ update: true }` (or `UPDATE_SCHEMAS=true` for a whole
 * run) to generate the schema from the real response. Review it, commit it, then remove the
 * flag: left on, it rewrites the schema from every response and hides real changes.
 *
 * @param name - schema name, e.g. `"posts/getPost"`
 * @param body - the parsed response body
 * @param options - see {@link ValidateOptions}
 * @throws Error if the schema file doesn't exist or can't be read
 *
 * @example
 * const body = await getBody(await Posts.list());
 * await validateJsonSchema("posts/listPosts", body);
 */
export declare function validateJsonSchema(name: string, body: unknown, { update, checkDates }?: ValidateOptions): Promise<void>;
