import { describe, expect, it } from "vitest";
import { linkFirstMention } from "./linkMention";

const id = "3dcb61fa-abc6-47ac-9916-06acf5b7fdf7";

describe("linkFirstMention", () => {
  it("links the first mention, keeping the text as written", () => {
    expect(linkFirstMention("<p>Read the Refund policy, then the refund policy again.</p>", "refund policy", id)).toBe(
      `<p>Read the <a data-type="page" data-id="${id}" href="/wiki/${id}">Refund policy</a>, then the refund policy again.</p>`,
    );
  });

  it("skips links, code and parts of words", () => {
    const html = `<p><a href="https://x.example">refunds</a> <code>refunds</code> prerefunds</p><p>Refunds.</p>`;
    expect(linkFirstMention(html, "Refunds", id)).toBe(
      `<p><a href="https://x.example">refunds</a> <code>refunds</code> prerefunds</p><p><a data-type="page" data-id="${id}" href="/wiki/${id}">Refunds</a>.</p>`,
    );
  });

  it("finds nothing to link", () => {
    expect(linkFirstMention("<p>Nothing here.</p>", "Refunds", id)).toBeNull();
    expect(linkFirstMention("<p>Anything</p>", "  ", id)).toBeNull();
  });
});
