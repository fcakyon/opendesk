import { describe, expect, it } from "vitest";
import { safeHtml } from "./html";
import { shortLabel, shortLinks, trimUrl } from "./links";

function links(html: string): { href: string; text: string; target: string | null; rel: string | null }[] {
  const d = document.createElement("div");
  d.innerHTML = html;
  return Array.from(d.querySelectorAll("a")).map((a) => ({
    href: a.getAttribute("href") ?? "",
    text: a.textContent ?? "",
    target: a.getAttribute("target"),
    rel: a.getAttribute("rel"),
  }));
}

const run = (html: string) => shortLinks(safeHtml(html));

describe("trimUrl", () => {
  it("leaves the sentence's punctuation out", () => {
    expect(trimUrl("https://example.com/help.")).toBe("https://example.com/help");
    expect(trimUrl("https://status.example.com/),")).toBe("https://status.example.com/");
    expect(trimUrl("https://example.com/a?b=1!")).toBe("https://example.com/a?b=1");
    expect(trimUrl("https://example.com/a…")).toBe("https://example.com/a");
  });

  it("keeps a closing parenthesis the address opened", () => {
    expect(trimUrl("https://en.wikipedia.org/wiki/Lamp_(design)")).toBe("https://en.wikipedia.org/wiki/Lamp_(design)");
    expect(trimUrl("https://en.wikipedia.org/wiki/Lamp_(design))")).toBe("https://en.wikipedia.org/wiki/Lamp_(design)");
  });
});

describe("shortLabel", () => {
  it("shows the host, without www, and a short path whole", () => {
    expect(shortLabel("https://status.example.com/")).toBe("status.example.com");
    expect(shortLabel("https://www.example.com/help/shipping")).toBe("example.com/help/shipping");
    expect(shortLabel("https://example.com/?ref=chat")).toBe("example.com");
  });

  it("cuts a long path to the segments that fit, else to the host", () => {
    expect(shortLabel("https://www.example.com/help/returns/start-a-return-for-an-order?order=1042&lang=en")).toBe("example.com/help/returns/…");
    expect(shortLabel("https://example.com/a-very-long-first-segment-of-a-path/and-more")).toBe("example.com/…");
  });

  it("decodes the path, and survives a broken escape", () => {
    expect(shortLabel("https://example.com/caf%C3%A9")).toBe("example.com/café");
    expect(shortLabel("https://example.com/100%")).toBe("example.com/100%");
  });
});

describe("shortLinks", () => {
  it("links an address written out, with a short label, the sentence's full stop outside", () => {
    const html = run("<p>Start your return here: https://example.com/help/returns/start-a-return-for-an-order?order=1042.</p>");
    expect(links(html)).toEqual([
      {
        href: "https://example.com/help/returns/start-a-return-for-an-order?order=1042",
        text: "example.com/help/returns/…",
        target: "_blank",
        rel: "noopener noreferrer nofollow",
      },
    ]);
    expect(html).toContain("</a>.</p>");
  });

  it("leaves a closing bracket the sentence opened outside", () => {
    const html = run("<p>(see https://example.com/help)</p>");
    expect(links(html).map((l) => l.href)).toEqual(["https://example.com/help"]);
    expect(html).toContain("</a>)</p>");
  });

  it("shortens a link that shows an address, keeps a link with words of its own", () => {
    const html = run(
      '<p><a href="https://status.example.com/">https://status.example.com/</a> or <a href="https://example.com/help/shipping">our shipping page</a></p>',
    );
    expect(links(html).map((l) => [l.href, l.text])).toEqual([
      ["https://status.example.com/", "status.example.com"],
      ["https://example.com/help/shipping", "our shipping page"],
    ]);
  });

  it("labels a link that shows another address with where it really goes", () => {
    const html = run('<p><a href="https://other.example.net/x">https://example.com/</a></p>');
    expect(links(html).map((l) => l.text)).toEqual(["other.example.net/x"]);
  });

  it("links www addresses and emails", () => {
    const html = run("<p>Write to help@example.com or see www.example.com/faq, then reply.</p>");
    expect(links(html).map((l) => [l.href, l.text])).toEqual([
      ["mailto:help@example.com", "help@example.com"],
      ["https://www.example.com/faq", "example.com/faq"],
    ]);
  });

  it("leaves code, other schemes and hosts without a dot as they are", () => {
    const html = run("<p><code>https://example.com/api</code> ftp://example.com www. http://localhost:3000</p><pre>see https://example.com</pre>");
    expect(links(html)).toEqual([]);
  });

  it("returns HTML without an address untouched", () => {
    const html = "<p>Thanks, <strong>see you</strong>!</p>";
    expect(shortLinks(html)).toBe(html);
  });

  it("never lets markup in", () => {
    const html = run('<p>https://example.com/"><img src=x onerror=alert(1)></p>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
    const escaped = shortLinks("<p>https://example.com/&lt;script&gt;alert(1)&lt;/script&gt;</p>");
    expect(escaped).not.toContain("<script");
  });
});
