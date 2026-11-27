package images_test

// Uploading a signature picture, serving it to anyone, and keeping it. Needs the test
// database (hdtest).

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"

	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/helpdesk/hdtest"
	"github.com/useopendesk/opendesk/internal/images"
)

func TestMain(m *testing.M) { hdtest.Main(m) }

func signaturePNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.NRGBA{uint8(x), 90, uint8(y), 255})
		}
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func pngSize(t *testing.T, b []byte) (int, int) {
	t.Helper()
	cfg, err := png.DecodeConfig(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	return cfg.Width, cfg.Height
}

func TestRenderSignatureKeepsShape(t *testing.T) {
	for _, c := range []struct{ w, h, wantW, wantH, smallW, smallH int }{
		{1200, 300, 600, 150, 64, 16}, // a wide logo: smaller, not squared
		{300, 900, 200, 600, 21, 64},  // a tall picture
		{120, 40, 120, 40, 64, 21},    // a small one is never made larger
	} {
		img, err := images.Decode(signaturePNG(t, c.w, c.h))
		if err != nil {
			t.Fatal(err)
		}
		p, err := images.RenderSignature(img)
		if err != nil {
			t.Fatal(err)
		}
		if w, h := pngSize(t, p.Large); w != c.wantW || h != c.wantH || p.Width != c.wantW || p.Height != c.wantH {
			t.Errorf("%dx%d: large %dx%d (reported %dx%d), want %dx%d", c.w, c.h, w, h, p.Width, p.Height, c.wantW, c.wantH)
		}
		if w, h := pngSize(t, p.Small); w != c.smallW || h != c.smallH {
			t.Errorf("%dx%d: small %dx%d, want %dx%d", c.w, c.h, w, h, c.smallW, c.smallH)
		}
	}
}

func TestSignatureImageUpload(t *testing.T) {
	e := hdtest.New(t, func(d *deps.Deps, api huma.API, r chi.Router) {
		images.RegisterSignature(d, api)
		images.Register(d, r)
	})
	ws := e.NewWorkspace()
	var got images.SignatureImage

	// Any member, a viewer too (they write their own signature); not without signing in.
	e.Upload("/v1/signature-images", hdtest.Auth{}, "logo.png", signaturePNG(t, 64, 64)).Want(t, 401)
	e.Upload("/v1/signature-images", ws.Viewer.As(ws), "logo.png", signaturePNG(t, 64, 64)).Want(t, 201)
	r := e.Upload("/v1/signature-images", ws.Agent.As(ws), "a.svg", []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)).Want(t, 422)
	if !strings.Contains(string(r.Body), "unsupported_image") {
		t.Fatalf("svg: %s", r.Body)
	}

	e.Upload("/v1/signature-images", ws.Agent.As(ws), "banner.png", append(signaturePNG(t, 1200, 300), []byte("<script>x</script>")...)).Want(t, 201).JSON(t, &got)
	if got.Width != 600 || got.Height != 150 {
		t.Fatalf("size %+v", got)
	}
	i := strings.Index(got.URL, "/v1/images/")
	if !strings.HasPrefix(got.URL, "http://api.test/v1/images/") || i < 0 {
		t.Fatalf("url %q", got.URL)
	}
	path := got.URL[i:]

	// Served to anyone (a recipient's mail client), as a fresh PNG of its own shape, cached for good.
	get := func() (*http.Response, []byte) {
		res, err := http.Get(e.Srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res, b
	}
	res, b := get()
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "image/png" || !strings.Contains(res.Header.Get("Cache-Control"), "immutable") {
		t.Fatalf("served %d %v", res.StatusCode, res.Header)
	}
	if bytes.Contains(b, []byte("script")) {
		t.Fatal("payload served")
	}
	if w, h := pngSize(t, b); w != 600 || h != 150 {
		t.Fatalf("served %dx%d", w, h)
	}

	// The sweep keeps a picture no signature took yet for a day, for an editor still open.
	e.Exec(`UPDATE images SET created_at = now() - interval '2 hours' WHERE workspace_id = $1`, ws.ID)
	if err := images.Collect(e.Ctx, e.D); err != nil {
		t.Fatal(err)
	}
	if res, _ := get(); res.StatusCode != 200 {
		t.Fatalf("collected: %d", res.StatusCode)
	}
	var n int
	e.Scalar(`SELECT count(*) FROM images WHERE workspace_id = $1 AND owner_type = 'user' AND owner_id = $2 AND slot = 'signature'`, &n, ws.ID, ws.Agent.ID)
	if n != 1 {
		t.Fatalf("%d signature images for the agent", n)
	}

	// A member keeps a bounded number of them.
	e.Exec(`INSERT INTO images (id, workspace_id, owner_type, owner_id, slot, source, storage_key, sha256)
		SELECT gen_random_uuid(), $1, 'user', $2, 'signature', 'upload', 'x', 'x' FROM generate_series(1, $3::int)`, ws.ID, ws.Admin.ID, images.MaxSignatureImages)
	r = e.Upload("/v1/signature-images", ws.Admin.As(ws), "logo.png", signaturePNG(t, 64, 64)).Want(t, 422)
	if !strings.Contains(string(r.Body), "too_many_images") {
		t.Fatalf("cap: %s", r.Body)
	}
}

// sigEnv is a server with signature pictures and a workspace.
func sigEnv(t *testing.T) (*hdtest.Env, hdtest.WS) {
	e := hdtest.New(t, func(d *deps.Deps, api huma.API, r chi.Router) {
		images.RegisterSignature(d, api)
		images.Register(d, r)
	})
	return e, e.NewWorkspace()
}

// upload sends a picture as u, wants status and returns the picture's URL.
func upload(t *testing.T, e *hdtest.Env, ws hdtest.WS, u hdtest.User, b []byte, status int) string {
	t.Helper()
	var got images.SignatureImage
	e.Upload("/v1/signature-images", u.As(ws), "logo.png", b).Want(t, status).JSON(t, &got)
	return got.URL
}

// imageID is the id in a picture's URL.
func imageID(url string) string { return url[strings.LastIndex(url, "/")+1:] }

// stored reports whether the picture's row is still there, with both its stored sizes.
func stored(t *testing.T, e *hdtest.Env, url string) bool {
	t.Helper()
	var n int
	e.Scalar(`SELECT count(*) FROM images WHERE id = $1`, &n, imageID(url))
	if n == 0 {
		return false
	}
	var key string
	e.Scalar(`SELECT storage_key FROM images WHERE id = $1`, &key, imageID(url))
	for _, k := range images.Keys(key) {
		r, err := e.D.Storage.Get(e.Ctx, k)
		if err != nil {
			t.Fatalf("%s: row kept, object %s gone: %v", url, k, err)
		}
		r.Close()
	}
	return true
}

func collect(t *testing.T, e *hdtest.Env) {
	t.Helper()
	if err := images.Collect(e.Ctx, e.D); err != nil {
		t.Fatal(err)
	}
}

func setSignature(e *hdtest.Env, ws hdtest.WS, u hdtest.User, html string) {
	e.Exec(`UPDATE members SET signature_html = $3 WHERE workspace_id = $1 AND user_id = $2`, ws.ID, u.ID, html)
}

func TestSignatureImageGivenBack(t *testing.T) {
	e, ws := sigEnv(t)
	logo := signaturePNG(t, 300, 100)
	first := upload(t, e, ws, ws.Agent, logo, 201)
	// Picked again (a replacement undone, the same logo in another signature): the same
	// picture, not one more toward the cap.
	if again := upload(t, e, ws, ws.Agent, logo, 200); again != first {
		t.Fatalf("again %s, want %s", again, first)
	}
	var n int
	e.Scalar(`SELECT count(*) FROM images WHERE workspace_id = $1 AND owner_id = $2 AND slot = 'signature'`, &n, ws.ID, ws.Agent.ID)
	if n != 1 {
		t.Fatalf("%d pictures stored", n)
	}
	// Another picture, and another member's copy of the same file, are their own.
	if other := upload(t, e, ws, ws.Agent, signaturePNG(t, 200, 100), 201); other == first {
		t.Fatal("another picture given the first one")
	}
	if theirs := upload(t, e, ws, ws.Admin, logo, 201); theirs == first {
		t.Fatal("another member given the agent's picture")
	}
	// A picture no signature took starts its day again when picked again.
	e.Exec(`UPDATE images SET created_at = now() - interval '23 hours' WHERE id = $1`, imageID(first))
	upload(t, e, ws, ws.Agent, logo, 200)
	e.Exec(`UPDATE images SET created_at = created_at - interval '2 hours' WHERE id = $1`, imageID(first))
	collect(t, e)
	if !stored(t, e, first) {
		t.Fatal("a picture picked again two hours ago was collected")
	}
	// A member at the cap still gets back a picture they have.
	e.Exec(`INSERT INTO images (id, workspace_id, owner_type, owner_id, slot, source, storage_key, sha256)
		SELECT gen_random_uuid(), $1, 'user', $2, 'signature', 'upload', 'x', 'x' FROM generate_series(1, $3::int)`, ws.ID, ws.Agent.ID, images.MaxSignatureImages)
	if again := upload(t, e, ws, ws.Agent, logo, 200); again != first {
		t.Fatalf("at the cap: %s", again)
	}
}

func TestSignatureImageSweep(t *testing.T) {
	e, ws := sigEnv(t)
	unused := upload(t, e, ws, ws.Agent, signaturePNG(t, 120, 40), 201)  // picked, never in a saved signature
	saved := upload(t, e, ws, ws.Agent, signaturePNG(t, 160, 40), 201)   // in the agent's signature
	team := upload(t, e, ws, ws.Agent, signaturePNG(t, 200, 40), 201)    // in a team's
	address := upload(t, e, ws, ws.Agent, signaturePNG(t, 240, 40), 201) // in a mailbox address's
	setSignature(e, ws, ws.Agent, `<p>Anna</p><img src="`+saved+`" alt="Acme" width="200" height="50">`)
	e.Exec(`INSERT INTO teams (workspace_id, name, signature_html) VALUES ($1, 'Sales', $2)`, ws.ID, `<img src="`+team+`" alt="Sales">`)
	settings, err := json.Marshal(map[string]any{"hello@acme.test": map[string]any{"signature_html": `<img src="` + address + `" alt="Hello">`}})
	if err != nil {
		t.Fatal(err)
	}
	e.Exec(`INSERT INTO mailboxes (id, workspace_id, name, email, inbound_kind, forwarding_token, outbound_kind, brand_id, alias_settings)
		VALUES (gen_random_uuid(), $1, 'Support', 'support@acme.test', 'forwarding', gen_random_uuid()::text, 'system', $2, $3)`, ws.ID, ws.BrandID, settings)
	collect(t, e)
	for _, u := range []string{unused, saved, team, address} {
		if !stored(t, e, u) {
			t.Fatalf("%s collected within its first hour", u)
		}
	}

	// A day on, the picture no saved signature named is gone; the others stay, also once their
	// signatures no longer name them: emails already sent show them.
	e.Exec(`UPDATE images SET created_at = now() - interval '25 hours' WHERE workspace_id = $1`, ws.ID)
	setSignature(e, ws, ws.Agent, `<p>Anna</p>`)
	e.Exec(`UPDATE teams SET signature_html = '' WHERE workspace_id = $1`, ws.ID)
	e.Exec(`UPDATE mailboxes SET alias_settings = '{}' WHERE workspace_id = $1`, ws.ID)
	collect(t, e)
	if stored(t, e, unused) {
		t.Fatal("a picture no signature named was kept")
	}
	res, err := http.Get(e.Srv.URL + "/v1/images/" + imageID(unused))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 404 {
		t.Fatalf("collected picture served: %d", res.StatusCode)
	}
	for _, u := range []string{saved, team, address} {
		if !stored(t, e, u) {
			t.Fatalf("%s, once in a signature, collected", u)
		}
	}
}

func TestSignatureImagesGoWithTheAccount(t *testing.T) {
	e, ws := sigEnv(t)
	own := upload(t, e, ws, ws.Agent, signaturePNG(t, 120, 40), 201)
	shared := upload(t, e, ws, ws.Agent, signaturePNG(t, 160, 40), 201)
	recent := upload(t, e, ws, ws.Agent, signaturePNG(t, 200, 40), 201)
	others := upload(t, e, ws, ws.Admin, signaturePNG(t, 120, 40), 201)
	setSignature(e, ws, ws.Agent, `<img src="`+own+`" alt="Anna"><img src="`+shared+`" alt="Acme">`)
	setSignature(e, ws, ws.Admin, `<img src="`+others+`" alt="Adam">`)
	e.Exec(`INSERT INTO teams (workspace_id, name, signature_html) VALUES ($1, 'Sales', $2)`, ws.ID, `<img src="`+shared+`" alt="Acme">`)
	collect(t, e) // the signatures take them
	e.Exec(`UPDATE images SET created_at = now() - interval '2 hours' WHERE workspace_id = $1 AND id <> $2`, ws.ID, imageID(recent))

	// The agent deletes their account: their membership and their own signature go with it.
	e.Exec(`DELETE FROM users WHERE id = $1`, ws.Agent.ID)
	collect(t, e)
	if stored(t, e, own) {
		t.Fatal("a deleted account's picture was kept")
	}
	// A picture a team's signature still shows stays until it no longer does; the other
	// members' pictures are theirs.
	if !stored(t, e, shared) || !stored(t, e, others) {
		t.Fatal("a picture a signature shows was collected")
	}
	// Uploaded in the last hour, it goes once it is an hour old, as every image.
	if !stored(t, e, recent) {
		t.Fatal("collected within its first hour")
	}
	e.Exec(`UPDATE teams SET signature_html = '' WHERE workspace_id = $1`, ws.ID)
	e.Exec(`UPDATE images SET created_at = now() - interval '2 hours' WHERE id = $1`, imageID(recent))
	collect(t, e)
	if stored(t, e, shared) || stored(t, e, recent) {
		t.Fatal("a deleted account's pictures outlived the signatures that showed them")
	}
	if !stored(t, e, others) {
		t.Fatal("another member's picture was collected")
	}
}
