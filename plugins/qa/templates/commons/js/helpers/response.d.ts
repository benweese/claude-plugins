/**
 * Response helpers used by every API test: {@link getBody} for success, {@link errorCheck} for
 * expected errors, and {@link timingCheck} for response times.
 *
 * @module response
 */
import { type APIResponse } from "@playwright/test";
/**
 * Asserts a 2xx status, parses the JSON body and disposes the response. Don't add a separate
 * status check next to it.
 *
 * @template T - the body's type, taken from the response: a client method declared as
 * `this.get<ProductList>(...)` makes this return a ProductList
 * @param response - the response to read
 * @returns the parsed body
 *
 * @example
 * const body = await getBody(await Products.list());
 */
export declare function getBody<T>(response: APIResponse<T>): Promise<T>;
/**
 * Asserts an error status (soft), disposes the response, and optionally checks the error
 * body against a schema.
 *
 * @param response - the response to check
 * @param status - the expected HTTP status, e.g. 404
 * @param options - optional checks on the error body
 * @param options.schema - schema name for the error body, e.g. `"errors/error"`
 * @returns the body: parsed JSON if it is JSON, otherwise the raw text
 *
 * @example
 * await errorCheck(await Posts.getPost("does-not-exist"), 404);
 */
export declare function errorCheck(response: APIResponse<unknown>, status: number, { schema }?: {
    schema?: string;
}): Promise<unknown>;
/** Settings for {@link timingCheck}. */
export interface TimingOptions {
    /** Calls to measure. Default `5`. */
    runs?: number;
    /**
     * Calls made first and not measured. Default `1`: a server is often slower on its first
     * request (cold caches), even with connection setup excluded.
     */
    warmup?: number;
}
/** What {@link timingCheck} measured, in milliseconds. */
export interface TimingResult {
    /** Average of `durations`. */
    averageMs: number;
    /** Request sent → last byte received, per measured call. */
    durations: number[];
    /** Request sent → first byte received (roughly the server's processing time), per measured call. */
    timeToFirstByte: number[];
}
/**
 * Measures calls with Playwright's resource timing (`response.timing()`) and asserts (soft)
 * that their average is within a limit. Each call is timed from the request being sent to the
 * last byte arriving, so DNS lookup, connection and TLS setup never count against the API.
 * Logs each duration and the average time to first byte.
 *
 * @param apiCall - makes the request, e.g. `() => Products.list()`
 * @param maxAverageMs - the highest acceptable average. Default `1000`
 * @param options - see {@link TimingOptions}
 * @returns the measurements, for further assertions
 *
 * @example
 * await timingCheck(() => Products.list(), 800);
 * const { timeToFirstByte } = await timingCheck(() => Products.search("top"), 1000, { runs: 10 });
 */
export declare function timingCheck(apiCall: () => Promise<APIResponse<unknown>>, maxAverageMs?: number, { runs, warmup }?: TimingOptions): Promise<TimingResult>;
