import { initClient } from "@ts-rest/core";
import { contract } from "@scottylabs-invites/contract";

export const api = initClient(contract, {
  baseUrl: "",
  baseHeaders: {},
  credentials: "include",
});

/** Unwraps a ts-rest result; throws the error body's message on non-2xx. */
export function unwrap<T extends { status: number; body: unknown }, S extends number>(
  result: T,
  okStatus: S,
): Extract<T, { status: S }>["body"] {
  if (result.status === okStatus) return (result as Extract<T, { status: S }>).body;
  const body = result.body as { message?: string; error?: string } | undefined;
  const err = new Error(body?.message ?? `Request failed (${result.status})`) as Error & {
    status: number;
    code?: string;
  };
  err.status = result.status;
  err.code = body?.error;
  throw err;
}
