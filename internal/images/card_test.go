package images

import (
	"net/url"
	"testing"
)

func TestParseCard(t *testing.T) {
	base, _ := url.Parse("https://www.example.com/post/1")
	c := parseCard([]byte(`<!doctype html><html><head>
		<title>  Plain   title </title>
		<meta name="description" content="Plain description">
		<meta property="og:title" content="Open &amp; Graph">
		<meta property="og:image" content="/img/card.png">
		</head><body><meta property="og:title" content="ignored"></body></html>`), base)
	if c.Title != "Open & Graph" || c.Description != "Plain description" || c.Image != "https://www.example.com/img/card.png" || c.Site != "example.com" {
		t.Fatalf("%+v", c)
	}

	c = parseCard([]byte(`<html><head><title>Only a title</title><meta property="og:image" content="http://insecure.example/x.png"></head></html>`), base)
	if c.Title != "Only a title" || c.Image != "" {
		t.Fatalf("%+v", c)
	}
}
