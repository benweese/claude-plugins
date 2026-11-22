/**
 * Polling for eventually-consistent APIs (background jobs, caches, search indexes), instead of
 * fixed waits.
 *
 * @module polling
 */
import { expect } from "@playwright/test";
/**
 * Calls an API repeatedly until its body meets a condition. Non-2xx responses count as
 * "not yet" and are retried. Fails the test if the condition isn't met within the timeout.
 *
 * @template T - the body's type, taken from the client method
 * @param apiCall - makes the request, e.g. `() => Posts.getPost(id)`
 * @param condition - returns true once the body is as expected
 * @param options - see {@link PollOptions}
 * @returns the body that met the condition
 *
 * @example
 * // Posts.getPost is declared as this.get<Post>(...), so body is a Post
 * const post = await pollUntil(
 * 	() => Posts.getPost(id),
 * 	(body) => body.status === "published",
 * 	{ message: "post to be published" }
 * );
 */
export async function pollUntil(apiCall, condition, { message = "condition to be met", intervals = [500, 1000, 2000], timeout = 10000 } = {}) {
    let body;
    await expect
        .poll(async () => {
        const response = await apiCall();
        if (!response.ok()) {
            await response.dispose();
            return false;
        }
        body = await response.json();
        await response.dispose();
        return condition(body);
    }, { message: `Waiting for ${message}`, intervals, timeout })
        .toBe(true);
    return body;
}
