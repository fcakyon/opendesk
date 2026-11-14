import { describe, expect, it } from "vitest";
import { EMBED_ORIGINS, embedFor } from "./embeds";

describe("embedFor", () => {
  it("plays known providers from their own origins", () => {
    const cases: [string, string][] = [
      ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42"],
      ["https://youtu.be/dQw4w9WgXcQ", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"],
      ["https://vimeo.com/76979871", "https://player.vimeo.com/video/76979871"],
      ["https://www.loom.com/share/0123456789abcdef0123456789abcdef", "https://www.loom.com/embed/0123456789abcdef0123456789abcdef"],
      ["https://docs.google.com/document/d/abc_123/edit", "https://docs.google.com/document/d/abc_123/preview"],
      ["https://docs.google.com/presentation/d/xyz/edit", "https://docs.google.com/presentation/d/xyz/embed"],
      ["https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC", "https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC"],
    ];
    for (const [link, src] of cases) expect(embedFor(link)?.src, link).toBe(src);
  });

  it("only ever loads an origin the CSP allows", () => {
    const links = [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.figma.com/design/AbC123/My-file?node-id=1-2",
      "https://drive.google.com/file/d/abc/view",
      "https://www.google.com/maps/place/Paris",
      "https://miro.com/app/board/uXjVO=/",
      "https://codepen.io/team/pen/abcd",
      "https://codesandbox.io/s/abc",
      "https://excalidraw.com/#json=abc,def",
      "https://airtable.com/shrAbc",
      "https://acme.typeform.com/to/AbCd",
      "https://calendly.com/acme/30min",
    ];
    for (const link of links) {
      const src = embedFor(link)?.src;
      expect(src, link).toBeTruthy();
      const origin = new URL(src!).origin;
      expect(EMBED_ORIGINS.some((o) => o === origin || (o.includes("*") && new RegExp(`^${o.replaceAll(".", "\\.").replaceAll("*", "[\\w-]+")}$`).test(origin))), origin).toBe(true);
    }
  });

  it("refuses anything else", () => {
    for (const link of ["http://www.youtube.com/watch?v=dQw4w9WgXcQ", "javascript:alert(1)", "https://evil.example/embed", "not a link"]) expect(embedFor(link), link).toBeNull();
  });
});
