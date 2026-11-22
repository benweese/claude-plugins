/**
 * JSON Schema validation for API responses.
 *
 * Schemas are files named `<schemasDir>/<name>.schema.json`, where the name can include
 * folders: `"posts/getPost"` → `schemas/posts/getPost.schema.json`. `schemasDir` defaults to
 * `<cwd>/schemas`; set it once with {@link configureSchemas}.
 *
 * @module validateJsonSchema
 */
import { expect } from "@playwright/test";
import { readFile } from "fs/promises";
import path from "path";
import { Ajv } from "ajv";
import addFormatsModule from "ajv-formats";
import { createJsonSchema, schemaFilePath } from "./createJsonSchema.js";
import { validateDatesInBody } from "./validateDates.js";
// ajv-formats is CommonJS: at runtime the default import is the plugin function itself.
const addFormats = addFormatsModule;
const settings = {
    schemasDir: path.join(process.cwd(), "schemas"),
    dateOptions: {}
};
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
/** Compiled validators by schema name, kept for the life of the worker. */
const validators = new Map();
/**
 * Sets where schemas live and how dates are checked. Call it once, from the test repo's config.
 * Clears the cache of compiled schemas.
 *
 * @param settings - see {@link SchemaSettings}; omitted settings keep their current value
 *
 * @example
 * configureSchemas({ schemasDir: path.join(root, "schemas") });
 */
export function configureSchemas({ schemasDir, dateOptions } = {}) {
    if (schemasDir) {
        settings.schemasDir = schemasDir;
    }
    if (dateOptions) {
        settings.dateOptions = dateOptions;
    }
    validators.clear();
}
/** Loads and compiles a schema the first time it is used, then returns the cached validator. */
async function loadValidator(name) {
    let validate = validators.get(name);
    if (!validate) {
        const file = schemaFilePath(settings.schemasDir, name);
        validate = ajv.compile(JSON.parse(await readFile(file, "utf8")));
        validators.set(name, validate);
    }
    return validate;
}
/** The keys in a JSON pointer: `/items/0/price` → `["items", "0", "price"]`. */
function pointerKeys(pointer) {
    return pointer
        .split("/")
        .slice(1)
        .map((key) => key.replace(/~1/g, "/").replace(/~0/g, "~"));
}
/** Turns a JSON pointer such as `/items/0/price` into `body.items[0].price`. */
function fieldPath(pointer) {
    return pointerKeys(pointer).reduce((path, key) => (/^\d+$/.test(key) ? `${path}[${key}]` : `${path}.${key}`), "body");
}
/** The value a JSON pointer points to in `body`, or undefined. */
function valueAt(body, pointer) {
    return pointerKeys(pointer).reduce((value, key) => value !== null && typeof value === "object" ? value[key] : undefined, body);
}
/**
 * One schema error as a line a person can act on, e.g. `body.items[0].price: must be number, got "12.50"`
 * or `body: unexpected field "extra"`.
 */
function describeSchemaError(error, body) {
    const where = fieldPath(error.instancePath);
    switch (error.keyword) {
        case "additionalProperties":
            return `${where}: unexpected field "${String(error.params.additionalProperty)}"`;
        case "required":
            return `${where}: missing field "${String(error.params.missingProperty)}"`;
        case "enum":
            return `${where}: must be one of ${JSON.stringify(error.params.allowedValues)}, got ${JSON.stringify(valueAt(body, error.instancePath))}`;
        default:
            return `${where}: ${error.message ?? error.keyword}, got ${JSON.stringify(valueAt(body, error.instancePath))}`;
    }
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
export async function validateJsonSchema(name, body, { update = false, checkDates = true } = {}) {
    if (update || process.env.UPDATE_SCHEMAS === "true") {
        await createJsonSchema(settings.schemasDir, name, body);
        validators.delete(name);
    }
    const validate = await loadValidator(name);
    const problems = validate(body) ? [] : (validate.errors ?? []).map((error) => describeSchemaError(error, body));
    expect.soft(problems, `Response matches schema "${name}"`).toEqual([]);
    if (checkDates) {
        validateDatesInBody(body, settings.dateOptions);
    }
}
