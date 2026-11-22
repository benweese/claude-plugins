/**
 * Base class for API clients.
 *
 * Each API area gets one client class that extends ApiBase and is exported as a singleton.
 * Specs call client methods, never `request` directly, so URLs, headers and logging live in
 * one place.
 *
 * @module ApiBase
 */
import { request } from "@playwright/test";
/**
 * Base class for one-client-per-API-area. Subclass it, add one method per endpoint, and
 * export a single instance.
 *
 * Name each response body's type in the method (`this.get<ProductList>(...)`), as Playwright's
 * own request methods allow. `getBody`, `pollUntil` and `response.json()` then return that type
 * without the spec repeating it.
 *
 * @example
 * class ProductsClient extends ApiBase {
 * 	constructor() {
 * 		super({ baseUrl: "https://example.com/api", bodyType: "form" });
 * 	}
 *
 * 	list() {
 * 		return this.get<ProductList>("productsList");
 * 	}
 * }
 *
 * export const Products = new ProductsClient();
 */
export class ApiBase {
    baseUrl;
    headers;
    bodyType;
    debug;
    context = null;
    /**
     * @param options - see {@link ApiBaseOptions}
     * @throws Error if `bodyType` is not `"json"` or `"form"`
     */
    constructor({ baseUrl, headers = {}, bodyType = "json", debug = false }) {
        if (!["json", "form"].includes(bodyType)) {
            throw new Error(`bodyType must be "json" or "form", got "${bodyType}"`);
        }
        this.baseUrl = baseUrl.replace(/\/$/, "");
        this.headers = headers;
        this.bodyType = bodyType;
        this.debug = debug;
    }
    /** The headers for the next request, calling the headers function if one was given. */
    resolveHeaders() {
        return typeof this.headers === "function" ? this.headers() : this.headers;
    }
    /**
     * Builds the full URL for a path.
     *
     * @param path - relative to the base URL; a leading slash is ignored
     * @returns e.g. `"https://example.com/api/products"` for `"products"`
     */
    uri(path) {
        return `${this.baseUrl}/${path.replace(/^\//, "")}`;
    }
    /** Logs a labelled value when `debug` is on. */
    log(label, value) {
        if (this.debug) {
            console.log(`=================== ${label} ===================`);
            console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
        }
    }
    /** The client's request context: created on first use, then reused for every request in the worker. */
    async requestContext() {
        this.context ??= await request.newContext();
        return this.context;
    }
    /** Releases the request context. Optional: call it from an `afterAll` if a worker creates many clients. */
    async dispose() {
        await this.context?.dispose();
        this.context = null;
    }
    /**
     * Sends a request. The caller asserts on the response, usually through `getBody` or
     * `errorCheck`, which also dispose it.
     *
     * @template T - the response body's type
     * @param method - HTTP method, any case
     * @param path - relative to the base URL
     * @param options - Playwright fetch options; their headers are merged over the client's
     * @returns the response, typed as `APIResponse<T>`
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same default as Playwright's APIResponse<T>
    async send(method, path, options = {}) {
        const url = this.uri(path);
        this.log("REQUEST", `${method.toUpperCase()} ${url}`);
        const payload = options.data ?? options.form;
        if (payload !== undefined) {
            this.log("REQUEST BODY", payload);
        }
        const context = await this.requestContext();
        const started = Date.now();
        const response = await context.fetch(url, {
            ...options,
            method: method.toUpperCase(),
            headers: { ...this.resolveHeaders(), ...options.headers }
        });
        this.log("RESPONSE", `${response.status()} in ${Date.now() - started}ms`);
        if (this.debug) {
            try {
                this.log("RESPONSE BODY", await response.json());
            }
            catch {
                this.log("RESPONSE BODY", await response.text());
            }
        }
        return response;
    }
    /** Wraps a payload as `data` (JSON) or `form`, depending on the client's `bodyType`. */
    body(payload) {
        if (payload === undefined) {
            return {};
        }
        return this.bodyType === "form"
            ? { form: payload }
            : { data: payload };
    }
    /**
     * Sends a GET request.
     *
     * @template T - the response body's type
     * @param path - relative to the base URL
     * @param params - query string parameters
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same default as Playwright's APIResponse<T>
    get(path, params) {
        return this.send("get", path, { params });
    }
    /**
     * Sends a POST request.
     *
     * @template T - the response body's type
     * @param path - relative to the base URL
     * @param payload - request body, encoded as the client's `bodyType`
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same default as Playwright's APIResponse<T>
    post(path, payload) {
        return this.send("post", path, this.body(payload));
    }
    /**
     * Sends a PUT request.
     *
     * @template T - the response body's type
     * @param path - relative to the base URL
     * @param payload - request body, encoded as the client's `bodyType`
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same default as Playwright's APIResponse<T>
    put(path, payload) {
        return this.send("put", path, this.body(payload));
    }
    /**
     * Sends a PATCH request.
     *
     * @template T - the response body's type
     * @param path - relative to the base URL
     * @param payload - request body, encoded as the client's `bodyType`
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same default as Playwright's APIResponse<T>
    patch(path, payload) {
        return this.send("patch", path, this.body(payload));
    }
    /**
     * Sends a DELETE request.
     *
     * @template T - the response body's type
     * @param path - relative to the base URL
     * @param payload - request body, encoded as the client's `bodyType`
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same default as Playwright's APIResponse<T>
    delete(path, payload) {
        return this.send("delete", path, this.body(payload));
    }
}
