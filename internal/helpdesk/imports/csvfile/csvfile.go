// Package csvfile reads the CSV files people upload to import tickets or people
// (contracts/imports.md), so every import reads them alike.
package csvfile

import (
	"bytes"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"
)

// MaxBytes is the largest CSV file an import takes.
const MaxBytes = 50 << 20

// maxRows bounds the rows of one file.
const maxRows = 500_000

// File is a parsed CSV file: its header and rows, with the line each row started on.
type File struct {
	Header []string
	Rows   [][]string
	Lines  []int
}

// ErrEmpty is a file with a header and no rows under it.
var ErrEmpty = errors.New("The file has no rows under its header.")

// Parse reads a CSV file: UTF-8 (with or without a byte order mark) or UTF-16 with one,
// separated by commas, semicolons or tabs, with a header row.
func Parse(raw []byte) (*File, error) {
	text, err := decodeText(raw)
	if err != nil {
		return nil, err
	}
	if !utf8.Valid(text) {
		return nil, errors.New("Save the file as UTF-8 and upload it again.")
	}
	r := csv.NewReader(bytes.NewReader(text))
	r.Comma = sniffComma(text)
	r.FieldsPerRecord = -1
	r.LazyQuotes = true
	r.ReuseRecord = false
	f := &File{}
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			var pe *csv.ParseError
			if errors.As(err, &pe) {
				return nil, fmt.Errorf("Line %d of the file could not be read: %s.", pe.Line, pe.Err)
			}
			return nil, err
		}
		if f.Header == nil {
			for i, h := range rec {
				h = strings.TrimSpace(h)
				if h == "" {
					h = "Column " + strconv.Itoa(i+1)
				}
				f.Header = append(f.Header, h)
			}
			continue
		}
		if blank(rec) {
			continue
		}
		if len(f.Rows) >= maxRows {
			return nil, fmt.Errorf("The file has more than %d rows. Split it into smaller files.", maxRows)
		}
		line, _ := r.FieldPos(0)
		f.Rows = append(f.Rows, rec)
		f.Lines = append(f.Lines, line)
	}
	if len(f.Header) == 0 || len(f.Rows) == 0 {
		return nil, ErrEmpty
	}
	return f, nil
}

func blank(rec []string) bool {
	for _, v := range rec {
		if strings.TrimSpace(v) != "" {
			return false
		}
	}
	return true
}

// decodeText strips a UTF-8 byte order mark and turns UTF-16 (with its mark) into UTF-8.
func decodeText(raw []byte) ([]byte, error) {
	switch {
	case bytes.HasPrefix(raw, []byte{0xEF, 0xBB, 0xBF}):
		return raw[3:], nil
	case bytes.HasPrefix(raw, []byte{0xFF, 0xFE}), bytes.HasPrefix(raw, []byte{0xFE, 0xFF}):
		out, _, err := transform.Bytes(unicode.UTF16(unicode.LittleEndian, unicode.UseBOM).NewDecoder(), raw)
		if err != nil {
			return nil, errors.New("The file's text could not be read. Save it as UTF-8 and upload it again.")
		}
		return out, nil
	}
	return raw, nil
}

// sniffComma picks the separator the header line uses most, outside quotes.
func sniffComma(text []byte) rune {
	end := bytes.IndexByte(text, '\n')
	if end < 0 {
		end = len(text)
	}
	counts := map[rune]int{}
	quoted := false
	for _, c := range string(text[:end]) {
		switch {
		case c == '"':
			quoted = !quoted
		case !quoted && (c == ',' || c == ';' || c == '\t'):
			counts[c]++
		}
	}
	best := ','
	for _, c := range []rune{';', '\t'} {
		if counts[c] > counts[best] {
			best = c
		}
	}
	return best
}

var headerSpace = regexp.MustCompile(`[\s_\-.]+`)

// NormHeader lowers a column name and folds its separators, so "E-mail" and "e mail" match.
func NormHeader(h string) string {
	return strings.TrimSpace(headerSpace.ReplaceAllString(strings.ToLower(h), " "))
}
