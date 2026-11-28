// Package images turns untrusted pictures (uploads, provider pictures, Gravatar, site
// icons) into small, metadata-free PNGs: it decodes PNG, JPEG, GIF and WebP only,
// bounds bytes and pixels, resizes to 256 and 64 px and re-encodes, so nothing of the
// original file (trailing payloads, metadata, other formats) is ever served.
package images

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"

	"golang.org/x/image/draw"
	"golang.org/x/image/webp"
)

// Limits on input.
const (
	MaxBytes     = 5 << 20
	MaxSide      = 4096
	MaxPixels    = 16 << 20
	MinSide      = 16
	LargeSize    = 256
	SmallSize    = 64
	minIconSide  = 32 // site icons smaller than this are not worth showing
	contentTypeP = "image/png"
)

var (
	// ErrUnsupported means the bytes are not a PNG, JPEG, GIF or WebP image that decodes.
	ErrUnsupported = errors.New("images: unsupported image")
	// ErrTooLarge means the file is over MaxBytes.
	ErrTooLarge = errors.New("images: file too large")
	// ErrDimensions means the image is too large or too small in pixels.
	ErrDimensions = errors.New("images: image dimensions out of range")
)

// Fit says how a non-square picture becomes square.
type Fit int

const (
	// Cover crops the centre (people).
	Cover Fit = iota
	// Contain fits the whole picture on a transparent square (logos).
	Contain
)

// Processed is a picture ready to store.
type Processed struct {
	Large  []byte // 256 px PNG; a signature picture's own shape, at most 600 px (RenderSignature)
	Small  []byte // 64 px PNG
	SHA256 string // of Large
	Width  int    // of the decoded source
	Height int
}

// Format is the sniffed container.
type Format string

const (
	FormatPNG  Format = "png"
	FormatJPEG Format = "jpeg"
	FormatGIF  Format = "gif"
	FormatWebP Format = "webp"
)

// Sniff identifies the format from the first bytes, or "".
func Sniff(b []byte) Format {
	switch {
	case bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n")):
		return FormatPNG
	case bytes.HasPrefix(b, []byte{0xff, 0xd8, 0xff}):
		return FormatJPEG
	case bytes.HasPrefix(b, []byte("GIF87a")), bytes.HasPrefix(b, []byte("GIF89a")):
		return FormatGIF
	case len(b) >= 12 && bytes.Equal(b[:4], []byte("RIFF")) && bytes.Equal(b[8:12], []byte("WEBP")):
		return FormatWebP
	}
	return ""
}

// ReadLimited reads at most MaxBytes from r, answering ErrTooLarge beyond.
func ReadLimited(r io.Reader, max int64) ([]byte, error) {
	b, err := io.ReadAll(io.LimitReader(r, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > max {
		return nil, ErrTooLarge
	}
	return b, nil
}

func decodeConfig(f Format, r io.Reader) (image.Config, error) {
	switch f {
	case FormatPNG:
		return png.DecodeConfig(r)
	case FormatJPEG:
		return jpeg.DecodeConfig(r)
	case FormatGIF:
		return gif.DecodeConfig(r)
	case FormatWebP:
		return webp.DecodeConfig(r)
	}
	return image.Config{}, ErrUnsupported
}

func decode(f Format, r io.Reader) (image.Image, error) {
	switch f {
	case FormatPNG:
		return png.Decode(r)
	case FormatJPEG:
		return jpeg.Decode(r)
	case FormatGIF:
		return gif.Decode(r) // first frame
	case FormatWebP:
		return webp.Decode(r)
	}
	return nil, ErrUnsupported
}

// Decode checks and decodes an image, honouring JPEG EXIF orientation.
func Decode(b []byte) (image.Image, error) {
	if len(b) > MaxBytes {
		return nil, ErrTooLarge
	}
	f := Sniff(b)
	if f == "" {
		return nil, ErrUnsupported
	}
	cfg, err := decodeConfig(f, bytes.NewReader(b))
	if err != nil {
		return nil, ErrUnsupported
	}
	if cfg.Width < MinSide || cfg.Height < MinSide || cfg.Width > MaxSide || cfg.Height > MaxSide ||
		cfg.Width*cfg.Height > MaxPixels {
		return nil, ErrDimensions
	}
	img, err := decode(f, bytes.NewReader(b))
	if err != nil {
		return nil, ErrUnsupported
	}
	if r := img.Bounds(); r.Dx() != cfg.Width || r.Dy() != cfg.Height {
		return nil, ErrUnsupported
	}
	if f == FormatJPEG {
		if o := jpegOrientation(b); o > 1 {
			img = orient(shrink(img, 2*LargeSize), o)
		}
	}
	return img, nil
}

// Process decodes b and renders both sizes.
func Process(b []byte, fit Fit) (Processed, error) {
	img, err := Decode(b)
	if err != nil {
		return Processed{}, err
	}
	return Render(img, fit)
}

// Render resizes a decoded image to both sizes and encodes PNGs.
func Render(img image.Image, fit Fit) (Processed, error) {
	r := img.Bounds()
	img = shrink(img, 4*LargeSize) // bounds the resampling work for large inputs
	large, err := encode(square(img, LargeSize, fit))
	if err != nil {
		return Processed{}, err
	}
	small, err := encode(square(img, SmallSize, fit))
	if err != nil {
		return Processed{}, err
	}
	sum := sha256.Sum256(large)
	return Processed{Large: large, Small: small, SHA256: hex.EncodeToString(sum[:]), Width: r.Dx(), Height: r.Dy()}, nil
}

func square(src image.Image, size int, fit Fit) *image.NRGBA {
	dst := image.NewNRGBA(image.Rect(0, 0, size, size))
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	switch fit {
	case Contain:
		draw.Draw(dst, dst.Bounds(), image.NewUniform(color.Transparent), image.Point{}, draw.Src)
		tw, th := size, size
		if w > h {
			th = max(1, size*h/w)
		} else {
			tw = max(1, size*w/h)
		}
		off := image.Pt((size-tw)/2, (size-th)/2)
		draw.CatmullRom.Scale(dst, image.Rectangle{Min: off, Max: off.Add(image.Pt(tw, th))}, src, b, draw.Over, nil)
	default:
		side := min(w, h)
		crop := image.Rect(b.Min.X+(w-side)/2, b.Min.Y+(h-side)/2, 0, 0)
		crop.Max = crop.Min.Add(image.Pt(side, side))
		draw.CatmullRom.Scale(dst, dst.Bounds(), src, crop, draw.Src, nil)
	}
	return dst
}

// shrink scales img down so its longer side is at most side (never up).
func shrink(img image.Image, side int) image.Image {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= side && h <= side {
		return img
	}
	tw, th := side, side
	if w > h {
		th = max(1, side*h/w)
	} else {
		tw = max(1, side*w/h)
	}
	dst := image.NewNRGBA(image.Rect(0, 0, tw, th))
	draw.ApproxBiLinear.Scale(dst, dst.Bounds(), img, b, draw.Src, nil)
	return dst
}

func encode(img image.Image) ([]byte, error) {
	var buf bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	if err := enc.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
