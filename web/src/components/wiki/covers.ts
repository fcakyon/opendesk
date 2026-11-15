// The covers the app paints itself (contracts/wiki.md "Page settings": cover "gradient:<name>").
// Soft, layered gradients in the brand's calm range; the API accepts exactly these names.

export const GRADIENTS = {
  dawn: "radial-gradient(120% 140% at 10% 0%, #ffd8c2 0%, transparent 55%), radial-gradient(120% 140% at 90% 100%, #f7c6dd 0%, transparent 60%), linear-gradient(120deg, #fff1e6, #fde2ec)",
  ocean: "radial-gradient(120% 140% at 0% 0%, #b9d7ff 0%, transparent 55%), radial-gradient(120% 140% at 100% 100%, #a8e6e0 0%, transparent 60%), linear-gradient(120deg, #e3efff, #dcf5f1)",
  forest: "radial-gradient(120% 140% at 10% 10%, #c4e8c9 0%, transparent 55%), radial-gradient(120% 140% at 90% 90%, #9fd3b8 0%, transparent 60%), linear-gradient(120deg, #eaf7ec, #d8efe4)",
  dusk: "radial-gradient(120% 140% at 0% 100%, #c9b8ff 0%, transparent 55%), radial-gradient(120% 140% at 100% 0%, #ffc0d9 0%, transparent 60%), linear-gradient(120deg, #ece6ff, #ffe6f0)",
  sand: "radial-gradient(120% 140% at 20% 0%, #f5e3c0 0%, transparent 55%), radial-gradient(120% 140% at 80% 100%, #ead7b5 0%, transparent 60%), linear-gradient(120deg, #fbf4e6, #f3e9d6)",
  slate: "radial-gradient(120% 140% at 0% 0%, #d7dce4 0%, transparent 55%), radial-gradient(120% 140% at 100% 100%, #c6ccd6 0%, transparent 60%), linear-gradient(120deg, #f1f3f6, #e3e7ed)",
  rose: "radial-gradient(120% 140% at 0% 0%, #ffc9d1 0%, transparent 55%), radial-gradient(120% 140% at 100% 100%, #ffd9c7 0%, transparent 60%), linear-gradient(120deg, #ffe9ec, #fff0e6)",
  lagoon: "radial-gradient(120% 140% at 10% 100%, #a6ece4 0%, transparent 55%), radial-gradient(120% 140% at 90% 0%, #b6d5ff 0%, transparent 60%), linear-gradient(120deg, #e0f8f4, #e6f0ff)",
  aurora: "radial-gradient(90% 120% at 0% 0%, #b7f0d8 0%, transparent 55%), radial-gradient(90% 120% at 50% 100%, #c8c2ff 0%, transparent 60%), radial-gradient(90% 120% at 100% 0%, #a9dcff 0%, transparent 55%), linear-gradient(120deg, #eefcf6, #eeeaff)",
  ember: "radial-gradient(120% 140% at 0% 100%, #ffc59e 0%, transparent 55%), radial-gradient(120% 140% at 100% 0%, #ffdf9e 0%, transparent 60%), linear-gradient(120deg, #fff0e3, #fff6df)",
} as const;

export type GradientName = keyof typeof GRADIENTS;
export const GRADIENT_NAMES = Object.keys(GRADIENTS) as GradientName[];

/** The CSS background of a cover value, or null for none. */
export function coverStyle(cover: string): { background?: string; image?: string } | null {
  if (!cover) return null;
  if (cover.startsWith("gradient:")) {
    const g = GRADIENTS[cover.slice(9) as GradientName];
    return g ? { background: g } : null;
  }
  return { image: cover };
}
