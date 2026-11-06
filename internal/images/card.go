package images

import (
	"bytes"
	"context"
	"net/url"
	"strings"
	"unicode/utf8"

	"golang.org/x/net/html"
)

// Card is what a page says about itself for a link preview: Open Graph first, then the
// page's own title and description.
type Card struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	Image       string `json:"image" doc:"An https image, or empty"`
	Site        string `json:"site"`
}

// LinkCard reads a web page through the SSRF guard (redirects re-validated) and returns
// its card. Only the head is read, up to 512 KB of HTML.
func (f *Fetcher) LinkCard(ctx context.Context, raw string) (Card, error) {
	b, _, final, err := f.get(ctx, raw, maxHTMLBytes, []string{"text/html", "application/xhtml+xml"}, nil)
	if err != nil {
		return Card{}, err
	}
	return parseCard(b, final), nil
}

func parseCard(b []byte, base *url.URL) Card {
	var c Card
	var docTitle, metaDesc string
	z := html.NewTokenizer(bytes.NewReader(b))
	inTitle := false
	for {
		tt := z.Next()
		switch tt {
		case html.ErrorToken:
			return finishCard(c, docTitle, metaDesc, base)
		case html.StartTagToken, html.SelfClosingTagToken:
			name, hasAttr := z.TagName()
			switch string(name) {
			case "title":
				inTitle = tt == html.StartTagToken
			case "body":
				return finishCard(c, docTitle, metaDesc, base)
			case "meta":
				var key, content string
				for hasAttr {
					var k, v []byte
					k, v, hasAttr = z.TagAttr()
					switch strings.ToLower(string(k)) {
					case "property", "name":
						key = strings.ToLower(string(v))
					case "content":
						content = string(v)
					}
				}
				switch key {
				case "og:title", "twitter:title":
					if c.Title == "" {
						c.Title = content
					}
				case "og:description", "twitter:description":
					if c.Description == "" {
						c.Description = content
					}
				case "description":
					metaDesc = content
				case "og:image", "og:image:secure_url", "twitter:image":
					if c.Image == "" {
						c.Image = content
					}
				case "og:site_name":
					c.Site = content
				}
			}
		case html.TextToken:
			if inTitle && docTitle == "" {
				docTitle = string(z.Text())
			}
		case html.EndTagToken:
			if name, _ := z.TagName(); string(name) == "title" {
				inTitle = false
			} else if string(name) == "head" {
				return finishCard(c, docTitle, metaDesc, base)
			}
		}
	}
}

func finishCard(c Card, docTitle, metaDesc string, base *url.URL) Card {
	if c.Title == "" {
		c.Title = docTitle
	}
	if c.Description == "" {
		c.Description = metaDesc
	}
	if c.Site == "" && base != nil {
		c.Site = strings.TrimPrefix(base.Hostname(), "www.")
	}
	c.Image = resolve(base, strings.TrimSpace(c.Image))
	if !strings.HasPrefix(c.Image, "https://") {
		c.Image = ""
	}
	c.Title = clip(c.Title, 300)
	c.Description = clip(c.Description, 500)
	c.Site = clip(c.Site, 100)
	return c
}

// clip folds whitespace and keeps at most n runes.
func clip(s string, n int) string {
	s = strings.Join(strings.Fields(html.UnescapeString(s)), " ")
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}
