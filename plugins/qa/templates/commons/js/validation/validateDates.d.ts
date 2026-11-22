/**
 * Date validation. `validateJsonSchema` runs {@link validateDatesInBody} on every response, so
 * date fields are checked automatically. Tests can also call {@link expectValidDate},
 * {@link expectDateBetween} and {@link expectSortedByDate} directly.
 *
 * "Valid" means ISO 8601 by default (2026-01-31, 2026-01-31T09:30:00Z,
 * 2026-01-31T09:30:00.123+01:00). Pass a dayjs format for anything else, e.g.
 * "YYYY-MM-DD HH:mm:ss" or "DD/MM/YYYY". Every check is a soft assertion, so one bad date
 * doesn't stop the rest of the test.
 *
 * @module validateDates
 */
import { type Dayjs } from "dayjs";
/** A date to compare against: an ISO string, a `Date` or a dayjs object. */
export type DateInput = string | Date | Dayjs;
/** Settings for {@link validateDatesInBody}. */
export interface DateOptions {
    /** Which keys hold dates. Default: keys ending in `At`, `Date`, `_at` or `_date`, or named `date` or `timestamp`. */
    dateKeys?: RegExp;
    /** dayjs format the dates use. Default: ISO 8601. */
    format?: string;
}
/** Settings for {@link expectValidDate} and {@link expectDateBetween}. */
export interface DateCheckOptions {
    /** dayjs format the value uses. Default: ISO 8601. */
    format?: string;
    /** Names the value in the failure message. Default `"date"`. */
    label?: string;
}
/**
 * Checks for a real ISO 8601 date or date-time. The shape must match and the day must exist,
 * so `"2026-02-30"` is rejected.
 *
 * @param value - anything
 * @returns true if `value` is a string holding a valid ISO 8601 date
 */
export declare function isIsoDate(value: unknown): value is string;
/**
 * Asserts (soft) that a value is a valid date.
 *
 * @param value - the value to check
 * @param options - see {@link DateCheckOptions}
 *
 * @example
 * expectValidDate(order.deliveryDate, { format: "DD/MM/YYYY", label: "deliveryDate" });
 */
export declare function expectValidDate(value: unknown, { format, label }?: DateCheckOptions): void;
/**
 * Asserts (soft) that a value is a valid date between two others, inclusive.
 *
 * @param value - the value to check
 * @param from - earliest allowed date
 * @param to - latest allowed date
 * @param options - see {@link DateCheckOptions}
 *
 * @example
 * // published within the last 7 days
 * expectDateBetween(post.publishedAt, dayjs().subtract(7, "day"), dayjs());
 */
export declare function expectDateBetween(value: unknown, from: DateInput, to: DateInput, { format, label }?: DateCheckOptions): void;
/**
 * Asserts (soft) that items are ordered by a date field. Reports every out-of-order pair.
 *
 * @param items - the items, in the order received
 * @param key - the date field on each item
 * @param order - `"desc"` (newest first) or `"asc"`. Default `"desc"`
 * @param options - how the dates are written
 * @param options.format - dayjs format of the dates. Default: ISO 8601
 *
 * @example
 * expectSortedByDate(body.items, "publishedAt", "desc");
 */
export declare function expectSortedByDate(items: readonly Record<string, unknown>[], key: string, order?: "desc" | "asc", { format }?: {
    format?: string;
}): void;
/**
 * Walks a response body and asserts (soft) that every date-like field holds a valid date.
 * Called by `validateJsonSchema` on every validation.
 *
 * @param body - the parsed response body
 * @param options - see {@link DateOptions}
 * @param path - where `body` sits in the response, for failure messages. Default `"body"`
 */
export declare function validateDatesInBody(body: unknown, { dateKeys, format }?: DateOptions, path?: string): void;
