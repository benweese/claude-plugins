/**
 * Base class for API clients.
 *
 * Each API area gets one client class that extends ApiBase and is exported as a singleton.
 * Specs call client methods, never `request` directly, so URLs, headers and logging live in
 * one place.
 *
 * @module ApiBase
 */
import { type APIRequestContext, type APIResponse } from "@playwright/test";
/** HTTP headers sent with every request. */
export type Headers = Record<string, string>;
/** How request bodies are encoded: `"json"` (application/json) or `"form"` (application/x-www-form-urlencoded). */
export type BodyType = "json" | "form";
/** Options Playwright's `APIRequestContext.fetch` accepts: params, data, form, multipart, headers, timeout, ... */
export type FetchOptions = NonNullable<Parameters<APIRequestContext["fetch"]>[1]>;
/** Settings for an {@link ApiBase} client. */
export interface ApiBaseOptions {
    /** API root, e.g. `"https://example.com/api"`. A trailing slash is removed. */
    baseUrl: string;
    /**
     * Headers for every request: a fixed object, or a function called per request. Use a function
     * for auth tokens that only exist after the client is created, e.g. set by a setup project.
     */
    headers?: Headers | (() => Headers);
    /** How post, put, patch and delete send their body. Default `"json"`. */
    bodyType?: BodyType;
    /** Log every request and response body to the console. Default `false`. */
    debug?: boolean;
}
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
export declare class ApiBase {
    protected readonly baseUrl: string;
    protected readonly headers: Headers | (() => Headers);
    protected readonly bodyType: BodyType;
    protected readonly debug: boolean;
    private context;
    /**
     * @param options - see {@link ApiBaseOptions}
     * @throws Error if `bodyType` is not `"json"` or `"form"`
     */
    constructor({ baseUrl, headers, bodyType, debug }: ApiBaseOptions);
    /** The headers for the next request, calling the headers function if one was given. */
    protected resolveHeaders(): Headers;
    /**
     * Builds the full URL for a path.
     *
     * @param path - relative to the base URL; a leading slash is ignored
     * @returns e.g. `"https://example.com/api/products"` for `"products"`
     */
    uri(path: string): string;
    /** Logs a labelled value when `debug` is on. */
    protected log(label: string, value: unknown): void;
    /** The client's request context: created on first use, then reused for every request in the worker. */
    protected requestContext(): Promise<APIRequestContext>;
    /** Releases the request context. Optional: call it from an `afterAll` if a worker creates many clients. */
    dispose(): Promise<void>;
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
    send<T = any>(method: string, path: string, options?: FetchOptions): Promise<APIResponse<T>>;
    /** Wraps a payload as `data` (JSON) or `form`, depending on the client's `bodyType`. */
    protected body(payload: unknown): FetchOptions;
    /**
     * Sends a GET request.
     *
     * @template T - the response body's type
     * @param path - relative to the base URL
     * @param params - query string parameters
     */
    get<T = any>(path: string, params?: FetchOptions["params"]): Promise<APIResponse<T>>;
    /**
     * Sends a POST request.
     *
     * @template T - the response body's type
     * @param path - relative to the base URL
     * @param payload - request body, encoded as the client's `bodyType`
     */
    post<T = any>(path: string, payload?: unknown): Promise<APIResponse<T>>;
    /**
     * Sends a PUT request.
     *
     * @template T - the response body's type
     * @param path - relative to the base URL
     * @param payload - request body, encoded as the client's `bodyType`
     */
    put<T = any>(path: string, payload?: unknown): Promise<APIResponse<T>>;
    /**
     * Sends a PATCH request.
     *
     * @template T - the response body's type
     * @param path - relative to the base URL
     * @param payload - request body, encoded as the client's `bodyType`
     */
    patch<T = any>(path: string, payload?: unknown): Promise<APIResponse<T>>;
    /**
     * Sends a DELETE request.
     *
     * @template T - the response body's type
     * @param path - relative to the base URL
     * @param payload - request body, encoded as the client's `bodyType`
     */
    delete<T = any>(path: string, payload?: unknown): Promise<APIResponse<T>>;
}
