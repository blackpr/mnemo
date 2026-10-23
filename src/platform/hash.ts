import { createHash } from "node:crypto";

/** The one hash the system uses for audit chains and erasure receipts. Injected into application code as a `Hasher`. */
export const sha256 = (input: string): string => createHash("sha256").update(input).digest("hex");
