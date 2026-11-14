// Package wikiport moves the internal wiki (contracts/wiki.md) in and out of other tools.
//
// Import reads an upload (a zip, or single Markdown, HTML, CSV or text files) from
// Obsidian, Notion, Confluence, Google Docs or any Markdown or HTML source, and answers a
// tree of pages whose bodies are wiki HTML (hd.SanitizeWiki), the files they use, and
// what was left out. Export writes pages as an Obsidian-friendly Markdown vault or as
// standalone HTML files.
//
// Nothing here reads the database or the network: the caller creates the pages and
// uploads the files, then puts their ids in the bodies with Result.Resolve.
//
// # Placeholders
//
// An imported body cannot hold the ids of pages and files that don't exist yet. Every
// Page and Asset of a Result gets a Ref: a random UUID, unique to that import, standing
// for its id until it has one. Bodies use refs exactly where ids go, so they pass
// hd.SanitizeWiki as they are:
//
//	link to a page   <a data-type="page" data-id="<ref>" href="/wiki/<ref>">text</a>
//	subpage block    <div data-type="subpage" data-id="<ref>"></div>
//	database block   <div data-type="database" data-id="<ref>" data-view="table"></div>
//	image            <img src="/v1/attachments/<ref>" alt="…">
//	file, media      <div data-type="file|video|audio" data-src="/v1/attachments/<ref>" data-name data-size data-mime></div>
//	link to a file   <a href="/v1/attachments/<ref>">text</a>
//
// A canvas (Page.Canvas) holds them too: a page card's page_id is a page's ref, a file
// card's src is /v1/attachments/<ref>, and text cards are bodies. Result.ResolveCanvas
// resolves a canvas as Resolve does a body.
//
// Headings carry a data-block-id of their own (a link to a heading names it in data-block
// and after "#" in its href): those are final, not refs.
//
// The caller uploads each asset as an attachment (hd.SaveUpload with Imported), picks an
// id for every page before it creates any (bodies link forward and back), and calls
// Result.Resolve(body, ids) with ref → id for every page and asset it created before it
// saves each body. A ref it leaves out (an asset refused at upload, a page over the
// workspace's limit) is taken out of the body: a link keeps its text, a block or image
// goes. Bodies are then saved as any other: hd.SanitizeWiki, tags and links indexed.
package wikiport

import (
	"io"
	"strings"

	"golang.org/x/net/html"

	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// Limits of an import. The wiki's own (contracts/wiki.md "Limits") still apply when the
// pages are created.
const (
	// MaxUploadBytes is the most an upload (the zip, or the files together) may weigh.
	MaxUploadBytes = 100 << 20
	// MaxTotalBytes is the most the files of an import may hold once uncompressed. Every
	// byte read out of an archive counts, whatever the archive declares.
	MaxTotalBytes = 200 << 20
	// MaxFileBytes is the largest file taken: an attachment's limit.
	MaxFileBytes = hd.MaxAttachmentBytes
	// MaxDocumentBytes is the largest page source (Markdown, HTML, CSV, text) read.
	MaxDocumentBytes = 4 << 20
	// MaxFiles is the most entries an upload may hold, folders included.
	MaxFiles = 10000
	// MaxPages is the most pages one import makes: a workspace's whole wiki.
	MaxPages = 5000
	// MaxPathDepth is the most folders a path in an archive may nest.
	MaxPathDepth = 32
	// MaxDepth is the most levels of pages an import makes (the wiki's depth). What is
	// below a page at the last level is placed beside it, after it.
	MaxDepth = 10
	// MaxRatio is the most an archive entry may expand from its compressed size, once it
	// is over ratioFloor bytes.
	MaxRatio   = 100
	ratioFloor = 1 << 20
	// MaxBodyBytes is the largest page body the wiki keeps.
	MaxBodyBytes = 512 << 10
	// maxTitle is the wiki's title length in characters.
	maxTitle = 200
)

// Errors an import answers; each is an *httpx.Error the caller can return as it is.
var (
	ErrUnsupported  = httpx.E(422, "import_unsupported", "This file can't be imported. Upload a zip, or Markdown, HTML, CSV or text files.")
	ErrUnreadable   = httpx.E(422, "import_unreadable", "The archive could not be read. Export it again and upload the new file.")
	ErrTooLarge     = httpx.E(413, "import_too_large", "The import holds more than 200 MB once unpacked, or the upload is over 100 MB. Split it into smaller exports.")
	ErrTooManyFiles = httpx.E(422, "import_too_many_files", "The import holds more than 10,000 files or 5,000 pages. Split it into smaller exports.")
	ErrUnsafePath   = httpx.E(422, "import_unsafe_path", "The archive holds links, absolute paths or paths that leave it. Only plain files and folders are imported.")
	ErrCompression  = httpx.E(422, "import_compression", "The archive expands far beyond its size. Only ordinary exports are imported.")
	ErrEmpty        = httpx.E(422, "import_empty", "The upload holds no pages to import.")
)

// Upload is one uploaded file: a zip, or a page source.
type Upload struct {
	Name string
	Body io.ReaderAt
	Size int64
}

// Options shape an import.
type Options struct {
	// Depth is how many levels of pages the import may use below where it lands; 0 is
	// MaxDepth. Under a page that is already 3 levels deep, it is MaxDepth-3.
	Depth int
}

// Page is a page to create. Children come in order.
type Page struct {
	// Key is where the page came from in the upload (its file, or its folder ending in
	// "/"), unique in the import.
	Key string
	// Ref stands for the page's id in bodies until it has one (see "Placeholders").
	Ref   string
	Title string
	// Icon is an emoji from the source (front matter, Notion's page icon), or "". The
	// caller checks it as the wiki checks every icon and leaves out one it refuses.
	Icon string
	// BodyHTML is the page's text as the wiki stores it: hd.SanitizeWiki of itself.
	BodyHTML string
	Children []*Page
	// Database makes the page a database (kind "database"): its children are its rows.
	Database *Database
	// Canvas makes the page a canvas (kind "canvas"), from an Obsidian canvas: page cards
	// hold the refs of the pages they show, file cards of their files (Result.ResolveCanvas).
	Canvas *Canvas
	// Props are a row's values by property id, shaped as contracts/wiki.md "Databases"
	// stores them; set only on the children of a database.
	Props map[string]any
	// Tags are the page's tags from its source's metadata (lower case, no "#"). They
	// are also written as #tags at the end of the body, where the wiki reads tags.
	Tags []string
	// Aliases are the page's other names from its front matter (aliases, alias).
	Aliases []string
	// Links are the keys of the imported pages the body links to, each once.
	Links []string
}

// Asset is a file a body uses, to be uploaded as an attachment.
type Asset struct {
	// Ref stands for the attachment's id in bodies until it has one.
	Ref string
	// Key is where the file came from in the upload.
	Key  string
	Name string // hd.CleanFilename of its name
	MIME string // hd.DetectType of its bytes and name
	Data []byte
}

// Skip is something the import left out or changed, for the app to list.
type Skip struct {
	// Path is the file or page in the upload (a page's Key).
	Path string `json:"path"`
	// Reason is a stable code:
	//   unsupported     a kind of file that isn't imported (Obsidian bases)
	//   unused          a file no page uses
	//   executable      a program or a script; never imported
	//   too_large       a file over MaxFileBytes, or a page source over MaxDocumentBytes
	//   unreadable      a file whose text or table could not be read
	//   body_too_large  a page whose text is over the wiki's 512 KB, or a canvas over 1 MB; the page is made without it
	//   moved_up        a page deeper than the wiki holds, placed beside its ancestor at the last level
	//   columns_dropped a table's columns past the database's 100 properties
	//   nested_archive  an archive inside an archive inside the upload
	//   canvas_simplified a canvas with cards the wiki keeps simpler: a card for a note's heading shows the
	//                   note, an http link or a file not in the upload is text, a group's picture and nodes
	//                   of unknown types are left out
	//   canvas_trimmed  a canvas's cards past 2,000 or connections past 4,000, left out
	Reason string `json:"reason"`
}

// Result is what an import found.
type Result struct {
	// Pages are the top-level pages, in order; each holds its subpages.
	Pages  []*Page
	Assets []Asset
	// Skipped lists what was left out or changed, in upload order.
	Skipped []Skip
	refs    map[string]bool
}

// Count is how many pages the result makes.
func (r *Result) Count() int {
	n := 0
	var walk func([]*Page)
	walk = func(ps []*Page) {
		for _, p := range ps {
			n++
			walk(p.Children)
		}
	}
	walk(r.Pages)
	return n
}

// Resolve puts ids in place of refs in a body of this result: ids maps a page's or an
// asset's Ref to the id it was created with. A ref without an id is taken out (a link
// keeps its text, an image or block goes). The body that comes back is sanitized.
func (r *Result) Resolve(body string, ids map[string]string) string {
	if body == "" {
		return ""
	}
	root := parseFragment(body)
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		for c := n.FirstChild; c != nil; {
			next := c.NextSibling
			if c.Type == html.ElementNode {
				if r.resolveNode(c, ids) {
					walk(c)
				}
			}
			c = next
		}
	}
	walk(root)
	return sanitize(renderChildren(root))
}

// resolveNode swaps refs for ids in n's attributes; false when n was taken out.
func (r *Result) resolveNode(n *html.Node, ids map[string]string) bool {
	missing := false
	for i, a := range n.Attr {
		switch a.Key {
		case "data-id", "href", "src", "data-src":
		default:
			continue
		}
		ref := refIn(a.Val)
		if ref == "" || !r.refs[ref] {
			continue
		}
		id, ok := ids[ref]
		if !ok || !uuidLike(id) {
			missing = true
			continue
		}
		n.Attr[i].Val = strings.Replace(a.Val, ref, strings.ToLower(id), 1)
	}
	if !missing {
		return true
	}
	if n.Data == "a" {
		unwrap(n)
		return false
	}
	n.Parent.RemoveChild(n)
	return false
}

// refIn finds the uuid in an attribute that may hold a ref: the value itself, or the last
// segment of /wiki/<ref> and /v1/attachments/<ref>.
func refIn(v string) string {
	v = strings.SplitN(v, "?", 2)[0]
	v = strings.SplitN(v, "#", 2)[0]
	if i := strings.LastIndexByte(v, '/'); i >= 0 {
		v = v[i+1:]
	}
	if uuidLike(v) {
		return strings.ToLower(v)
	}
	return ""
}

func uuidLike(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i := 0; i < 36; i++ {
		c := s[i]
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
				return false
			}
		}
	}
	return true
}

// sanitize is hd.SanitizeWiki until it settles, so a stored body reads the same when it
// is sanitized again.
func sanitize(raw string) string {
	out := hd.SanitizeWiki(raw)
	for range 3 {
		again := hd.SanitizeWiki(out)
		if again == out {
			break
		}
		out = again
	}
	return out
}
