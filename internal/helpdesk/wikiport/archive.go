package wikiport

import (
	"archive/zip"
	"bytes"
	"errors"
	"io"
	"path"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"

	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// ErrTooDeep refuses an archive whose folders nest deeper than MaxPathDepth.
var ErrTooDeep = httpx.E(422, "import_too_deep", "The archive's folders nest more than 32 levels deep.")

// file is one file of the upload. Page sources are read as the upload is listed; other
// files only once a page uses them, each read counted against MaxTotalBytes.
type file struct {
	path string // slash-separated, relative, cleaned
	size int64  // declared
	data []byte
	read bool
	open func() (io.ReadCloser, error)
	comp uint64 // compressed size, 0 for a single file
}

// files is the upload as a tree of paths.
type files struct {
	list   []*file
	byPath map[string]*file
	lower  map[string]*file // lower-cased path, for links typed in another case
	total  int64
	skips  []Skip
	// obsidian: the upload is a vault (it has .obsidian/); notion: names carry Notion's ids.
	obsidian, notion bool
}

func newFiles() *files {
	return &files{byPath: map[string]*file{}, lower: map[string]*file{}}
}

// readUploads lists the upload: each zip unpacked, each other file taken as it is.
func readUploads(ups []Upload) (*files, error) {
	fs := newFiles()
	var size int64
	for _, u := range ups {
		size += u.Size
	}
	if size > MaxUploadBytes {
		return nil, ErrTooLarge
	}
	if len(ups) > MaxFiles {
		return nil, ErrTooManyFiles
	}
	if len(ups) == 0 {
		return nil, ErrEmpty
	}
	pages := false
	for _, u := range ups {
		if u.Size < 0 || u.Body == nil {
			return nil, ErrUnreadable
		}
		head := make([]byte, min(u.Size, 4))
		_, _ = u.Body.ReadAt(head, 0)
		if strings.EqualFold(path.Ext(u.Name), ".zip") || bytes.HasPrefix(head, []byte("PK\x03\x04")) {
			if err := fs.addZip(u.Body, u.Size, "", 0); err != nil {
				return nil, err
			}
			pages = true
			continue
		}
		pages = pages || sourceKind(u.Name) != ""
		name := hd.CleanFilename(u.Name)
		r := io.NewSectionReader(u.Body, 0, u.Size)
		fs.add(&file{path: name, size: u.Size, open: func() (io.ReadCloser, error) { return io.NopCloser(r), nil }})
	}
	if !pages {
		return nil, ErrUnsupported
	}
	if err := fs.readSources(); err != nil {
		return nil, err
	}
	return fs, nil
}

// ignored are files every export tool leaves beside the content: system files, an
// Obsidian vault's settings and trash, version control.
func ignored(p string) bool {
	for _, seg := range strings.Split(p, "/") {
		if strings.HasPrefix(seg, ".") || seg == "__MACOSX" || seg == "Thumbs.db" || seg == "desktop.ini" {
			return true
		}
	}
	return false
}

// addZip lists an archive's files under prefix. An archive inside the upload's archive
// (Notion splits a large export into parts) is unpacked too, one level down only.
func (fs *files) addZip(ra io.ReaderAt, size int64, prefix string, level int) error {
	zr, err := zip.NewReader(ra, size)
	if err != nil {
		return ErrUnreadable
	}
	if len(zr.File)+len(fs.list) > MaxFiles {
		return ErrTooManyFiles
	}
	for _, f := range zr.File {
		name, err := entryPath(f)
		if err != nil {
			return err
		}
		if strings.HasPrefix(name, ".obsidian/") || strings.Contains(name, "/.obsidian/") {
			fs.obsidian = true
		}
		if name == "" || ignored(name) {
			continue
		}
		mode := f.Mode()
		if mode&^0o777 != 0 && !mode.IsDir() {
			return ErrUnsafePath // links, devices, pipes
		}
		if mode.IsDir() || strings.HasSuffix(f.Name, "/") {
			continue
		}
		if f.UncompressedSize64 > ratioFloor && f.UncompressedSize64 > MaxRatio*max(f.CompressedSize64, 1) {
			return ErrCompression
		}
		full := path.Join(prefix, name)
		if strings.Count(full, "/") >= MaxPathDepth {
			return ErrTooDeep
		}
		if strings.EqualFold(path.Ext(full), ".zip") {
			if level > 0 {
				fs.skip(full, "nested_archive")
				continue
			}
			data, err := fs.readEntry(f, int64(f.UncompressedSize64), f.CompressedSize64, MaxUploadBytes)
			if err != nil {
				return err
			}
			if err := fs.addZip(bytes.NewReader(data), int64(len(data)), strings.TrimSuffix(path.Dir(full), "."), level+1); err != nil {
				return err
			}
			continue
		}
		f := f
		fs.add(&file{path: full, size: int64(f.UncompressedSize64), comp: f.CompressedSize64, open: f.Open})
	}
	return nil
}

// entryPath is an archive entry's path, cleaned; a path that is absolute or leaves the
// archive is refused. Names not marked UTF-8 that aren't are read as code page 437, the
// zip format's own.
func entryPath(f *zip.File) (string, error) {
	name := f.Name
	if !utf8.ValidString(name) {
		if s, err := charmap.CodePage437.NewDecoder().String(name); err == nil {
			name = s
		}
	}
	name = strings.ReplaceAll(name, `\`, "/")
	if strings.HasPrefix(name, "/") || (len(name) >= 2 && name[1] == ':') || strings.ContainsRune(name, 0) {
		return "", ErrUnsafePath
	}
	for _, seg := range strings.Split(name, "/") {
		if seg == ".." {
			return "", ErrUnsafePath
		}
	}
	clean := path.Clean(name)
	if clean == "." {
		return "", nil
	}
	return clean, nil
}

func (fs *files) add(f *file) {
	if _, dup := fs.byPath[f.path]; dup {
		return
	}
	fs.list = append(fs.list, f)
	fs.byPath[f.path] = f
	if _, ok := fs.lower[strings.ToLower(f.path)]; !ok {
		fs.lower[strings.ToLower(f.path)] = f
	}
}

func (fs *files) skip(p, reason string) {
	fs.skips = append(fs.skips, Skip{Path: p, Reason: reason})
}

// readSources reads every page source, so the pages can be laid out.
func (fs *files) readSources() error {
	for _, f := range fs.list {
		if sourceKind(f.path) == "" {
			continue
		}
		if f.size > MaxDocumentBytes {
			fs.skip(f.path, "too_large")
			continue
		}
		if _, err := fs.load(f, MaxDocumentBytes); err != nil {
			if errors.Is(err, errFileTooLarge) {
				fs.skip(f.path, "too_large")
				continue
			}
			return err
		}
	}
	return nil
}

var errFileTooLarge = errors.New("file too large")

// load reads a file once, at most limit bytes.
func (fs *files) load(f *file, limit int64) ([]byte, error) {
	if f.read {
		return f.data, nil
	}
	if f.size > limit {
		return nil, errFileTooLarge
	}
	rc, err := f.open()
	if err != nil {
		return nil, ErrUnreadable
	}
	defer rc.Close()
	data, err := fs.readCounted(rc, f.size, f.comp, limit)
	if err != nil {
		return nil, err
	}
	f.data, f.read = data, true
	return data, nil
}

func (fs *files) readEntry(f *zip.File, size int64, comp uint64, limit int64) ([]byte, error) {
	rc, err := f.Open()
	if err != nil {
		return nil, ErrUnreadable
	}
	defer rc.Close()
	return fs.readCounted(rc, size, comp, limit)
}

// readCounted reads what an entry holds, refusing more than it declared, more than the
// limit, more than the import may hold altogether, and more than MaxRatio times what it
// takes compressed. Every byte read counts, whatever the archive said.
func (fs *files) readCounted(r io.Reader, declared int64, comp uint64, limit int64) ([]byte, error) {
	var buf bytes.Buffer
	chunk := make([]byte, 32<<10)
	for {
		n, err := r.Read(chunk)
		if n > 0 {
			buf.Write(chunk[:n])
			fs.total += int64(n)
			got := int64(buf.Len())
			switch {
			case got > declared:
				return nil, ErrCompression
			case got > limit:
				return nil, errFileTooLarge
			case fs.total > MaxTotalBytes:
				return nil, ErrTooLarge
			case comp > 0 && got > ratioFloor && uint64(got) > MaxRatio*comp:
				return nil, ErrCompression
			}
		}
		if err == io.EOF {
			return buf.Bytes(), nil
		}
		if errors.Is(err, zip.ErrFormat) {
			return nil, ErrCompression // more than the entry declared
		}
		if err != nil {
			return nil, ErrUnreadable
		}
	}
}

// sourceKind is the kind of page a file is the source of, or "".
func sourceKind(p string) string {
	switch strings.ToLower(path.Ext(p)) {
	case ".md", ".markdown":
		return "md"
	case ".html", ".htm":
		return "html"
	case ".txt":
		return "txt"
	case ".csv":
		return "csv"
	case ".canvas":
		return "canvas"
	}
	return ""
}

// decodeText reads text in UTF-8 (with or without its byte order mark), UTF-16 with its
// mark, or else Windows-1252, the encoding older tools save in. NULs are dropped.
func decodeText(raw []byte) string {
	var s string
	switch {
	case bytes.HasPrefix(raw, []byte{0xEF, 0xBB, 0xBF}):
		s = string(raw[3:])
	case bytes.HasPrefix(raw, []byte{0xFF, 0xFE}), bytes.HasPrefix(raw, []byte{0xFE, 0xFF}):
		out, _, err := transform.Bytes(unicode.UTF16(unicode.LittleEndian, unicode.UseBOM).NewDecoder(), raw)
		if err != nil {
			return ""
		}
		s = string(out)
	case utf8.Valid(raw):
		s = string(raw)
	default:
		out, err := charmap.Windows1252.NewDecoder().Bytes(raw)
		if err != nil {
			return strings.ToValidUTF8(string(raw), "�")
		}
		s = string(out)
	}
	s = strings.ReplaceAll(s, "\x00", "")
	return strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\r", "\n")
}
