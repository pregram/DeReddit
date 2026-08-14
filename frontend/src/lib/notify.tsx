import { notifications } from "@mantine/notifications";
import { IconCircleX } from "@tabler/icons-react";

/**
 * Shows a red error toast, styled to match the "cannot upvote your own post" style
 * failure toast TransactionContext's trackTransaction already fires for on-chain errors.
 */
export function notifyError(message: string, title = "Error") {
  notifications.show({
    title,
    message,
    color: "red",
    icon: <IconCircleX size={18} stroke={1.75} />,
  });
}

/**
 * TransactionContext's trackTransaction already shows this same toast for every on-chain
 * failure before rethrowing. Callers tag that rethrown error so a wrapping catch here
 * doesn't double-toast, while still toasting failures that never reached trackTransaction
 * (validation, IPFS, API reads).
 * @param error - the error to tag
 * @returns the same error, mutated with an `alreadyNotified` marker
 */
export function markAlreadyNotified<E extends Error>(error: E): E {
  return Object.assign(error, { alreadyNotified: true as const });
}

/** Checks whether `err` was already tagged by {@link markAlreadyNotified}. */
export function isAlreadyNotified(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { alreadyNotified?: boolean }).alreadyNotified === true;
}
