// Closing a session kills the agent in it, with no undo, so the cap arms on the first tap and acts
// on the second - the only protection a phone has against a thumb landing 6mm off.

/** What one tap on a tab's close cap does: which tab is armed afterwards, and whether to close. */
export const nextArm = (
  armed: string | undefined,
  id: string,
): { armed: string | undefined; close: boolean } =>
  armed === id ? { armed: undefined, close: true } : { armed: id, close: false };
