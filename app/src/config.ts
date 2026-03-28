/** How long to wait after the last utterance before sending to the backend (ms) */
export const UTTERANCE_TIMEOUT_MS = 2000;

/**
 * Wake word phrases that activate Edith (case-insensitive).
 * Everything after the wake word in the same utterance is sent as the query.
 * If the wake word is said alone, the next utterance is captured as the query.
 */
export const WAKE_WORDS = ["hey edith", "ok edith"];

/** How long the mic stays "active" after wake word before going back to idle (ms) */
export const WAKE_TIMEOUT_MS = 10000;

/** How long to keep listening for follow-up after Edith responds (ms) */
export const FOLLOWUP_WINDOW_MS = 8000;
