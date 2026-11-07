import { getHTMLFromFragment, getSchema } from "@tiptap/core";
import { DetailsContent, DetailsSummary } from "@tiptap/extension-details";
import { DOMParser as PMDOMParser } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import { ButtonBlock, Transclusion } from "./blocks";
import { WikiDetails } from "./extensions";
import { Footnote, FootnoteRef, Footnotes } from "./footnotes";

// What the editor reads and writes for the newer blocks: the markup hd.SanitizeWiki keeps
// (internal/helpdesk/hd/testdata/wiki_editor.html has the same), and nothing it would drop.
const schema = getSchema([StarterKit, WikiDetails.configure({ HTMLAttributes: { class: "wiki-toggle" } }), DetailsSummary, DetailsContent, Transclusion, ButtonBlock, FootnoteRef, Footnotes, Footnote]);
const roundTrip = (html: string) => {
  const el = document.createElement("div");
  el.innerHTML = html;
  return getHTMLFromFragment(PMDOMParser.fromSchema(schema).parse(el).content, schema);
};

const P = "3dcb61fa-abc6-47ac-9916-06acf5b7fdf7";
const B = "c61e7b00-13ee-469c-9759-6c85e6e3453e";
const N = "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a";

describe("the newer blocks' HTML", () => {
  it("keeps a synced block's page and block", () => {
    expect(roundTrip(`<div data-type="transclusion" data-id="${P}" data-block="${B}"></div>`)).toBe(`<div data-id="${P}" data-block="${B}" data-type="transclusion"></div>`);
    expect(roundTrip(`<div data-type="transclusion" data-id="${P}"></div>`)).toBe(`<div data-id="${P}" data-type="transclusion"></div>`);
    expect(roundTrip(`<div data-type="transclusion" data-id="../x" data-block="top"></div>`)).toBe(`<div data-type="transclusion"></div>`);
  });

  it("keeps a button's label, action and targets, and drops what doesn't fit", () => {
    expect(roundTrip(`<div data-type="button" data-label="Log a bug" data-action="row" data-database="${P}" data-title="New bug" data-props='{"urgent":true}'></div>`)).toBe(
      `<div data-label="Log a bug" data-action="row" data-database="${P}" data-title="New bug" data-props="{&quot;urgent&quot;:true}" data-type="button"></div>`,
    );
    expect(roundTrip(`<div data-type="button" data-label="Go" data-action="eval" data-url="javascript:alert(1)" data-template="x"></div>`)).toBe(`<div data-label="Go" data-type="button"></div>`);
  });

  it("keeps footnotes and their numbers", () => {
    const html = `<p>A claim<sup data-type="footnote" data-note="${N}">1</sup>.</p><div data-type="footnotes"><div data-type="footnote" data-note="${N}"><p>The source.</p></div></div>`;
    expect(roundTrip(html)).toBe(html);
    // A plain superscript is not a footnote.
    expect(roundTrip(`<p>x<sup>2</sup></p>`)).toBe(`<p>x2</p>`);
  });

  it("keeps a toggle heading's level", () => {
    expect(roundTrip(`<details data-heading="2"><summary>Folded</summary><div data-type="detailsContent"><p>In</p></div></details>`)).toBe(
      `<details class="wiki-toggle" data-heading="2"><summary>Folded</summary><div data-type="detailsContent"><p>In</p></div></details>`,
    );
    expect(roundTrip(`<details data-heading="7"><summary>s</summary><div data-type="detailsContent"><p>x</p></div></details>`)).toBe(
      `<details class="wiki-toggle"><summary>s</summary><div data-type="detailsContent"><p>x</p></div></details>`,
    );
  });
});
