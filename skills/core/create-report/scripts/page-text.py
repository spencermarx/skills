#!/usr/bin/env python3
"""Print a rendered report page as the text a reader meets, in reading order.

The reader check hands this text to a blind reader, so it carries what the page
shows and nothing else: headings marked with #, the always-visible summary of an
accordion marked [card], a diagram's own labels marked [figure], table rows with
their cells separated by |. Every line inside an accordion that loads closed is
marked [inside card], because a reader does not see it until they open the card.
Styles, scripts and other attributes are dropped.

Usage: page-text.py <report.html>
"""

import sys
from html.parser import HTMLParser

SKIP = {"style", "script", "head", "title", "noscript"}
BLOCK = {
    "p", "li", "dt", "dd", "blockquote", "figcaption", "caption", "pre",
    "tr", "div", "section", "article", "header", "footer", "details", "summary",
    "figure", "table", "ul", "ol", "dl", "br", "hr",
}
HEADINGS = {"h1": "# ", "h2": "## ", "h3": "### ", "h4": "#### ", "h5": "##### ", "h6": "###### "}


class PageText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.lines = []
        self.buf = []
        self.skip = 0
        self.svg = 0
        self.svg_labels = []
        self.prefix = ""
        # One entry per open <details>: [loads open, inside its own <summary>].
        self.details = []

    def hidden(self):
        return "[inside card] " if any(not d[0] and not d[1] for d in self.details) else ""

    def flush(self):
        text = " ".join("".join(self.buf).split())
        if text:
            self.lines.append(self.hidden() + self.prefix + text)
        self.buf = []
        self.prefix = ""

    def handle_starttag(self, tag, attrs):
        if tag in SKIP:
            self.skip += 1
            return
        if tag == "svg":
            self.flush()
            self.svg += 1
            return
        if self.svg:
            if tag == "text":
                self.svg_labels.append("")
            return
        if tag in HEADINGS:
            self.flush()
            self.prefix = HEADINGS[tag]
        elif tag == "summary":
            self.flush()
            if self.details:
                self.details[-1][1] = True
            self.prefix = "[card] "
        elif tag in BLOCK:
            self.flush()
            if tag == "details":
                self.details.append(["open" in dict(attrs), False])
        elif tag in ("td", "th") and self.buf:
            self.buf.append(" | ")

    def handle_endtag(self, tag):
        if tag in SKIP:
            self.skip = max(0, self.skip - 1)
            return
        if tag == "svg":
            self.svg = max(0, self.svg - 1)
            if not self.svg:
                labels = [" ".join(l.split()) for l in self.svg_labels]
                labels = [l for l in labels if l]
                if labels:
                    self.lines.append(self.hidden() + "[figure] " + " · ".join(labels))
                self.svg_labels = []
            return
        if self.svg:
            return
        if tag in HEADINGS or tag in BLOCK:
            self.flush()
        if tag == "summary" and self.details:
            self.details[-1][1] = False
        elif tag == "details" and self.details:
            self.details.pop()

    def handle_data(self, data):
        if self.skip:
            return
        if self.svg:
            if self.svg_labels:
                self.svg_labels[-1] += data
            return
        self.buf.append(data)


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: page-text.py <report.html>")
    parser = PageText()
    with open(sys.argv[1], encoding="utf-8") as f:
        parser.feed(f.read())
    parser.flush()
    print("\n".join(parser.lines))


if __name__ == "__main__":
    main()
