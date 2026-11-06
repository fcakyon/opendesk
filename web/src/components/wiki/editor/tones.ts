/** The soft colours text, highlights and callouts take: the web tokens', so dark mode follows. */
export const TONES = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;
export type Tone = (typeof TONES)[number];
export const isTone = (v: string | null | undefined): v is Tone => !!v && (TONES as readonly string[]).includes(v);
