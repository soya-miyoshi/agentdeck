// Closing a session kills the agent running in it, and there is no undo. The cap therefore arms on
// the first tap and acts on the second, which is the only protection a phone has against a thumb
// landing 6mm from where it meant to.

/** What one tap on a tab's close cap does: which tab is armed afterwards, and whether to close. */
export const nextArm = (
  armed: string | undefined,
  id: string,
): { armed: string | undefined; close: boolean } =>
  armed === id ? { armed: undefined, close: true } : { armed: id, close: false };
