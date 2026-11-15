import { describe, expect, it } from "vitest";
import { embedStop, MAX_EMBED_DEPTH, outlineOf, parseBlockLink, sectionOf } from "./transclude";

const A = "3dcb61fa-abc6-47ac-9916-06acf5b7fdf7";
const B = "9a1f7c2e-1b4d-4e8a-9c3f-2d5e6f7a8b9c";
const C = "5b0a9f8e-7d6c-4b5a-8e9f-0a1b2c3d4e5f";
const D = "0d6c2f8a-7b1e-4c3d-8f5a-2e9b4a6c1d70";
const H1 = "11111111-1111-4111-8111-111111111111";
const H2 = "22222222-2222-4222-8222-222222222222";
const H3 = "33333333-3333-4333-8333-333333333333";
const T2 = "44444444-4444-4444-8444-444444444444";
const LI = "55555555-5555-4555-8555-555555555555";

describe("embedStop", () => {
  it("lets a page show another", () => {
    expect(embedStop([A], B)).toBeNull();
    expect(embedStop([A, B], C)).toBeNull();
  });
  it("never shows the page being read inside itself", () => {
    expect(embedStop([A], A)).toBe("self");
    expect(embedStop([A], A.toUpperCase())).toBe("self");
    // A synced block of the page itself, even deeper, is the page showing itself.
    expect(embedStop([A, B], A)).toBe("self");
  });
  it("stops a loop through other pages", () => {
    expect(embedStop([A, B, C], B)).toBe("loop");
    expect(embedStop([A, B], B)).toBe("loop");
  });
  it("stops nesting past the limit", () => {
    const chain = [A, B, C, D].slice(0, MAX_EMBED_DEPTH + 1);
    expect(chain).toHaveLength(MAX_EMBED_DEPTH + 1);
    expect(embedStop(chain, "66666666-6666-4666-8666-666666666666")).toBe("deep");
    expect(embedStop(chain.slice(0, MAX_EMBED_DEPTH), "66666666-6666-4666-8666-666666666666")).toBeNull();
  });
});

const page =
  `<p>Intro</p>` +
  `<h1 data-block-id="${H1}">Guide</h1><p>Guide text</p>` +
  `<h2 data-block-id="${H2}">Steps</h2><p>One</p><ol><li data-block-id="${LI}"><p>first</p></li><li><p>second</p></li></ol>` +
  `<h3 data-block-id="${H3}">Detail</h3><p>Deep</p>` +
  `<details data-heading="2" data-block-id="${T2}"><summary>Folded</summary><div data-type="detailsContent"><p>Inside</p></div></details>` +
  `<p>After the fold</p>` +
  `<h2>No id</h2><p>Tail</p>` +
  `<div data-type="callout" data-block-id="${A}"><p data-block-id="${B}">Tip</p></div>`;

describe("sectionOf", () => {
  it("takes a heading and what follows, up to the next heading of its level or higher", () => {
    expect(sectionOf(page, H2)).toBe(`<h2 data-block-id="${H2}">Steps</h2><p>One</p><ol><li data-block-id="${LI}"><p>first</p></li><li><p>second</p></li></ol><h3 data-block-id="${H3}">Detail</h3><p>Deep</p>`);
    expect(sectionOf(page, H3)).toBe(`<h3 data-block-id="${H3}">Detail</h3><p>Deep</p>`);
  });
  it("counts a toggle heading as a heading that ends a section", () => {
    const h1 = sectionOf(page, H1)!;
    expect(h1).toContain("Folded");
    expect(h1).toContain("Tail");
    expect(sectionOf(page, H3)).not.toContain("Folded");
  });
  it("takes a toggle heading or any other block alone", () => {
    expect(sectionOf(page, T2)).toBe(`<details data-heading="2" data-block-id="${T2}"><summary>Folded</summary><div data-type="detailsContent"><p>Inside</p></div></details>`);
    expect(sectionOf(page, A)).toBe(`<div data-type="callout" data-block-id="${A}"><p data-block-id="${B}">Tip</p></div>`);
    expect(sectionOf(page, B)).toBe(`<p data-block-id="${B}">Tip</p>`);
  });
  it("keeps a list item in a list of its kind", () => {
    expect(sectionOf(page, LI)).toBe(`<ol><li data-block-id="${LI}"><p>first</p></li></ol>`);
  });
  it("is null for a block the page doesn't have, or no id at all", () => {
    expect(sectionOf(page, C)).toBeNull();
    expect(sectionOf(page, `"] , *[x="`)).toBeNull();
  });
});

describe("outlineOf", () => {
  it("lists the headings a synced block can show, toggle headings too", () => {
    expect(outlineOf(page)).toEqual([
      { id: H1, level: 1, text: "Guide" },
      { id: H2, level: 2, text: "Steps" },
      { id: H3, level: 3, text: "Detail" },
      { id: T2, level: 2, text: "Folded" },
    ]);
  });
});

describe("parseBlockLink", () => {
  const origin = "https://app.opendesk.sh";
  it("reads a copied block link of this wiki", () => {
    expect(parseBlockLink(`${origin}/wiki/${A.toUpperCase()}#${B}`, origin)).toEqual({ id: A, block: B });
    expect(parseBlockLink(`  ${origin}/wiki/${A}#${B}\n`, origin)).toEqual({ id: A, block: B });
  });
  it("refuses a page link without a block, another site or another path", () => {
    expect(parseBlockLink(`${origin}/wiki/${A}`, origin)).toBeNull();
    expect(parseBlockLink(`https://evil.example/wiki/${A}#${B}`, origin)).toBeNull();
    expect(parseBlockLink(`${origin}/tickets/${A}#${B}`, origin)).toBeNull();
    expect(parseBlockLink(`${origin}/wiki/${A}#top`, origin)).toBeNull();
    expect(parseBlockLink("not a link", origin)).toBeNull();
  });
});
