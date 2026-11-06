// What the wiki's embed block plays in place (contracts/wiki.md "Embeds"). A page keeps
// only the link a person pasted; this maps it to the provider's own embed address, which
// the app loads in a sandboxed frame. The frame origins here are the only ones the app's
// Content-Security-Policy frame-src lets in (internal/app/app.go embedFrameSources and
// deploy/cloudflare/pages/app/_headers); anything else shows as a bookmark.

export type EmbedProvider = { id: string; name: string; src: string; height: number; ratio?: number };

type Rule = { id: string; name: string; test: RegExp; to: (m: RegExpMatchArray, u: URL) => string | null; height?: number; ratio?: number };

const RULES: Rule[] = [
  {
    id: "youtube",
    name: "YouTube",
    test: /^https:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?.*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/,
    to: (m, u) => {
      const t = Number.parseInt(u.searchParams.get("t") ?? "", 10);
      return `https://www.youtube-nocookie.com/embed/${m[1]}${t > 0 ? `?start=${t}` : ""}`;
    },
    ratio: 16 / 9,
  },
  { id: "vimeo", name: "Vimeo", test: /^https:\/\/(?:www\.)?vimeo\.com\/(\d+)/, to: (m) => `https://player.vimeo.com/video/${m[1]}`, ratio: 16 / 9 },
  { id: "loom", name: "Loom", test: /^https:\/\/(?:www\.)?loom\.com\/(?:share|embed)\/([0-9a-f]{32})/, to: (m) => `https://www.loom.com/embed/${m[1]}`, ratio: 16 / 10 },
  {
    id: "figma",
    name: "Figma",
    test: /^https:\/\/(?:www\.)?figma\.com\/(?:file|design|proto|board|slides)\/[\w-]+/,
    to: (_m, u) => {
      const node = u.searchParams.get("node-id");
      return `https://embed.figma.com${u.pathname}?embed-host=opendesk${node ? `&node-id=${encodeURIComponent(node)}` : ""}`;
    },
    height: 480,
  },
  {
    id: "google",
    name: "Google Docs",
    test: /^https:\/\/docs\.google\.com\/(document|spreadsheets|presentation|forms)\/d\/(e\/)?([\w-]+)/,
    to: (m) => {
      const kind = m[1];
      const tail = kind === "presentation" ? "embed" : kind === "forms" ? "viewform?embedded=true" : m[2] ? "pubhtml?widget=true" : "preview";
      return `https://docs.google.com/${kind}/d/${m[2] ? "e/" : ""}${m[3]}/${tail}`;
    },
    height: 560,
  },
  { id: "drive", name: "Google Drive", test: /^https:\/\/drive\.google\.com\/file\/d\/([\w-]+)/, to: (m) => `https://drive.google.com/file/d/${m[1]}/preview`, height: 480 },
  {
    id: "maps",
    name: "Google Maps",
    test: /^https:\/\/(?:www\.)?google\.[a-z.]+\/maps\/(?:place|search)\/([^/?#]+)/,
    to: (m) => `https://www.google.com/maps?q=${m[1]}&output=embed`,
    height: 400,
  },
  { id: "miro", name: "Miro", test: /^https:\/\/miro\.com\/app\/board\/([\w=-]+)/, to: (m) => `https://miro.com/app/live-embed/${m[1]}/`, height: 480 },
  { id: "codepen", name: "CodePen", test: /^https:\/\/codepen\.io\/([\w-]+)\/(?:pen|full|details)\/([\w-]+)/, to: (m) => `https://codepen.io/${m[1]}/embed/${m[2]}?default-tab=result`, height: 420 },
  { id: "codesandbox", name: "CodeSandbox", test: /^https:\/\/codesandbox\.io\/(?:s|p\/sandbox|embed)\/([\w-]+)/, to: (m) => `https://codesandbox.io/embed/${m[1]}`, height: 500 },
  { id: "spotify", name: "Spotify", test: /^https:\/\/open\.spotify\.com\/(track|album|playlist|episode|show)\/(\w+)/, to: (m) => `https://open.spotify.com/embed/${m[1]}/${m[2]}`, height: 152 },
  { id: "excalidraw", name: "Excalidraw", test: /^https:\/\/excalidraw\.com\/(#json=[\w,-]+)/, to: (m) => `https://excalidraw.com/${m[1]}`, height: 480 },
  { id: "airtable", name: "Airtable", test: /^https:\/\/airtable\.com\/(?:embed\/)?(shr\w+)/, to: (m) => `https://airtable.com/embed/${m[1]}`, height: 533 },
  { id: "typeform", name: "Typeform", test: /^https:\/\/([\w-]+)\.typeform\.com\/to\/(\w+)/, to: (m) => `https://${m[1]}.typeform.com/to/${m[2]}`, height: 500 },
  { id: "calendly", name: "Calendly", test: /^https:\/\/calendly\.com\/([\w/-]+)/, to: (m) => `https://calendly.com/${m[1]}?embed_type=Inline`, height: 660 },
];

/** The frame origins embeds load from; the CSP lists exactly these (embeds.test.ts and app_test.go keep them aligned). */
export const EMBED_ORIGINS = [
  "https://www.youtube-nocookie.com",
  "https://player.vimeo.com",
  "https://www.loom.com",
  "https://embed.figma.com",
  "https://docs.google.com",
  "https://drive.google.com",
  "https://www.google.com",
  "https://miro.com",
  "https://codepen.io",
  "https://codesandbox.io",
  "https://open.spotify.com",
  "https://excalidraw.com",
  "https://airtable.com",
  "https://*.typeform.com",
  "https://calendly.com",
] as const;

/** The embed of a link, or null when no provider plays it. */
export function embedFor(raw: string): EmbedProvider | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const href = u.toString();
  for (const r of RULES) {
    const m = href.match(r.test);
    if (!m) continue;
    const src = r.to(m, u);
    if (!src) continue;
    return { id: r.id, name: r.name, src, height: r.height ?? 400, ratio: r.ratio };
  }
  return null;
}

/** The providers, for the empty embed's help line. */
export const EMBED_NAMES = [...new Set(RULES.map((r) => r.name))];
