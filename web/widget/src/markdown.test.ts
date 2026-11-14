import { render } from "preact";
import { describe, expect, it } from "vitest";
import { plainText, renderMarkdown, stripMarkers } from "./markdown";

const html = (md: string, streaming = false) => {
  const el = document.createElement("div");
  render(renderMarkdown(md, streaming), el);
  return el.innerHTML;
};

describe("citation markers", () => {
  it("removes [n] markers but keeps links and other brackets", () => {
    expect(stripMarkers("Upload the certificate [1]. Then sign in [2][3].")).toBe("Upload the certificate. Then sign in.");
    expect(stripMarkers("See [1, 2] for more")).toBe("See for more");
    expect(stripMarkers("A [guide](https://x.test) and [1](https://y.test)")).toBe("A [guide](https://x.test) and [1](https://y.test)");
    expect(stripMarkers("Option [a] stays")).toBe("Option [a] stays");
  });

  it("hides a marker cut off mid-stream", () => {
    expect(stripMarkers("Upload it [", true)).toBe("Upload it");
    expect(stripMarkers("Upload it [1", true)).toBe("Upload it");
    expect(stripMarkers("Upload it [1", false)).toBe("Upload it [1");
  });
});

describe("markdown preview", () => {
  it("renders paragraphs, lists, bold and safe links", () => {
    const out = html("Hi **there** [1].\n\n- one\n- two\n\nRead [the guide](https://example.com/g).");
    expect(out).toContain("<p>Hi <strong>there</strong>.</p>");
    expect(out).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(out).toContain('<a href="https://example.com/g" target="_blank" rel="noopener noreferrer nofollow">the guide</a>');
  });

  it("labels an address written out shortly, as the posted reply shows it", () => {
    const out = html("Start here: https://www.example.com/help/returns/start-a-return-for-an-order?order=1042.");
    expect(out).toBe(
      '<p>Start here: <a href="https://www.example.com/help/returns/start-a-return-for-an-order?order=1042" target="_blank" rel="noopener noreferrer nofollow">example.com/help/returns/…</a>.</p>',
    );
  });

  it("never turns text into markup or unsafe links", () => {
    const out = html('<img src=x onerror=alert(1)> [x](javascript:alert(1)) <script>bad()</script>');
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("javascript:");
    expect(out).toContain("&lt;img");
  });

  it("hides markup that is still being written", () => {
    expect(html("This is **impor", true)).toBe("<p>This is impor</p>");
    expect(html("See [the gui", true)).toBe("<p>See the gui</p>");
    expect(html("See [the guide](https://exa", true)).toBe("<p>See the guide</p>");
  });

  it("gives plain text for announcements", () => {
    expect(plainText("**Done** [1]. See [guide](https://x.test).")).toBe("Done. See guide.");
  });
});
