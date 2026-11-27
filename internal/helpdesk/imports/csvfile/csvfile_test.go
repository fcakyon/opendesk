package csvfile

import (
	"errors"
	"slices"
	"testing"

	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"
)

func mustParse(t *testing.T, raw []byte) *File {
	t.Helper()
	f, err := Parse(raw)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	return f
}

func TestParseEncodings(t *testing.T) {
	plain := "Subject,Body\nHello,World\n"
	want := [][]string{{"Hello", "World"}}

	f := mustParse(t, []byte(plain))
	if !slices.Equal(f.Header, []string{"Subject", "Body"}) || !slices.Equal(f.Rows[0], want[0]) {
		t.Fatalf("plain: %+v", f)
	}

	f = mustParse(t, append([]byte{0xEF, 0xBB, 0xBF}, plain...))
	if f.Header[0] != "Subject" {
		t.Fatalf("utf-8 bom left in header: %q", f.Header[0])
	}

	for _, end := range []unicode.Endianness{unicode.LittleEndian, unicode.BigEndian} {
		enc, _, err := transform.Bytes(unicode.UTF16(end, unicode.UseBOM).NewEncoder(), []byte("Subject\tBody\nCafé ☕\tÜber\n"))
		if err != nil {
			t.Fatal(err)
		}
		if end == unicode.LittleEndian && !(enc[0] == 0xFF && enc[1] == 0xFE) {
			t.Fatalf("expected a little endian bom, got % x", enc[:2])
		}
		f = mustParse(t, enc)
		if !slices.Equal(f.Header, []string{"Subject", "Body"}) {
			t.Fatalf("utf-16 %v header %q", end, f.Header)
		}
		if !slices.Equal(f.Rows[0], []string{"Café ☕", "Über"}) {
			t.Fatalf("utf-16 %v row %q", end, f.Rows[0])
		}
	}

	if _, err := Parse([]byte("Subject\n\xff\xfe\xfd broken\n")); err == nil {
		t.Fatal("invalid utf-8 without a bom was accepted")
	}
	if _, err := Parse([]byte("Subject,Body\n\n , \n")); !errors.Is(err, ErrEmpty) {
		t.Fatalf("header only: %v", err)
	}
}

func TestParseSeparators(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want []string
	}{
		{"comma", "a,b,c\n1,2,3\n", []string{"1", "2", "3"}},
		{"semicolon", "a;b;c\n1;2,5;3\n", []string{"1", "2,5", "3"}},
		{"tab", "a\tb\tc\n1\t2;x\t3\n", []string{"1", "2;x", "3"}},
		// Separators inside quotes in the header do not count.
		{"quoted header", "\"a,b,c,d\";e;f\n1;2;3\n", []string{"1", "2", "3"}},
	}
	for _, c := range cases {
		f := mustParse(t, []byte(c.raw))
		if !slices.Equal(f.Rows[0], c.want) {
			t.Errorf("%s: row %q, want %q", c.name, f.Rows[0], c.want)
		}
	}
	if got := sniffComma([]byte("x")); got != ',' {
		t.Errorf("default separator %q", got)
	}
}

func TestParseMultilineAndLines(t *testing.T) {
	raw := "ticket id,body,\n" +
		"1,\"first line\nsecond line\nthird\",\n" + // rows start on lines 2..4
		"\n" + // a blank line is skipped
		"2,\"say \"\"hi\"\"\",\n" + // line 6
		"3,short,extra\n" // line 7
	f := mustParse(t, []byte(raw))
	if len(f.Rows) != 3 {
		t.Fatalf("rows %d: %q", len(f.Rows), f.Rows)
	}
	if f.Rows[0][1] != "first line\nsecond line\nthird" {
		t.Fatalf("multiline field %q", f.Rows[0][1])
	}
	if f.Rows[1][1] != `say "hi"` {
		t.Fatalf("escaped quotes %q", f.Rows[1][1])
	}
	if !slices.Equal(f.Lines, []int{2, 6, 7}) {
		t.Fatalf("lines %v", f.Lines)
	}
	if f.Header[2] != "Column 3" {
		t.Fatalf("unnamed column %q", f.Header[2])
	}
}
