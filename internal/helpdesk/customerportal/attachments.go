package customerportal

import (
	"context"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
)

const (
	// maxFileBytes is the size of one file a customer sends: a screenshot or a document, not a video.
	maxFileBytes = 10 << 20
	// maxFilesPerRequest is how many files one new request carries.
	maxFilesPerRequest = 5
	// uploadsPerHour bounds the files one customer uploads, counted for the whole instance.
	uploadsPerHour = 30
	// maxUploadBody leaves room for the multipart envelope around a file.
	maxUploadBody = maxFileBytes + 1<<20
)

type uploadForm struct {
	File huma.FormFile `form:"file" required:"true" doc:"The file, at most 10 MB"`
}

type uploadInput struct {
	RawBody huma.MultipartFormFiles[uploadForm]
}

// customerAttachment is a file of a public message, with a link that opens it for a while.
type customerAttachment struct {
	ID          uuid.UUID `json:"id"`
	Filename    string    `json:"filename"`
	ContentType string    `json:"content_type"`
	SizeBytes   int64     `json:"size_bytes"`
	URL         string    `json:"url"`
}

// acceptFile limits what one customer file may be. Programs and scripts are refused before it
// is asked, and active types are stored as plain text, as for every upload (hd.SaveUpload).
func acceptFile(_ []byte, _ string, size int64) error {
	if size > maxFileBytes {
		return httpx.E(http.StatusRequestEntityTooLarge, "too_large", "Files can be at most 10 MB.")
	}
	return nil
}

// limitBody caps the request body before huma parses the multipart form.
func limitBody(api huma.API) func(huma.Context, func(huma.Context)) {
	return func(ctx huma.Context, next func(huma.Context)) {
		r, w := humachi.Unwrap(ctx)
		if r.ContentLength > maxUploadBody {
			_ = huma.WriteErr(api, ctx, http.StatusRequestEntityTooLarge, "Files can be at most 10 MB.")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxUploadBody)
		next(ctx)
	}
}

func (s *service) registerAttachments(api huma.API) {
	op := s.operation("customer-portal-upload-attachment", http.MethodPost, "/v1/customer/portal/attachments", "Upload a file for a request", false)
	op.DefaultStatus = http.StatusCreated
	op.MaxBodyBytes = maxUploadBody
	op.Middlewares = append(op.Middlewares, limitBody(api))
	huma.Register(api, op, func(ctx context.Context, in *uploadInput) (*struct{ Body domain.Attachment }, error) {
		if f := in.RawBody.Form; f != nil {
			defer func() { _ = f.RemoveAll() }()
		}
		p, err := auth.RequireCustomer(ctx)
		if err != nil {
			return nil, httpx.Wrap(err)
		}
		if err := s.limit(ctx, "upload:"+p.WorkspaceID.String()+":"+p.ContactID.String(), uploadsPerHour, time.Hour); err != nil {
			return nil, err
		}
		data := in.RawBody.Data()
		if data == nil || data.File.File == nil || !data.File.IsSet {
			return nil, httpx.Validation("file is required")
		}
		defer data.File.Close()
		a, err := hd.SaveUpload(ctx, s.d.Storage, s.d.DB.Pool, hd.Upload{WorkspaceID: p.WorkspaceID, UploadedByContact: &p.ContactID,
			Filename: data.File.Filename, Size: data.File.Size, Body: data.File.File, Accept: acceptFile})
		if err != nil {
			return nil, httpx.Wrap(err)
		}
		return &struct{ Body domain.Attachment }{a}, nil
	})
}

// requestFiles checks the files a new request names are this customer's own unsent uploads and
// within the limits, and returns their ids.
func (s *service) requestFiles(ctx context.Context, tx pgx.Tx, p *auth.Principal, raw []string) ([]uuid.UUID, error) {
	if len(raw) > maxFilesPerRequest {
		return nil, httpx.E(http.StatusUnprocessableEntity, "too_many_files", "A request can carry at most 5 files.")
	}
	ids, err := hd.ParseAttachmentIDs(raw)
	if err != nil {
		return nil, err
	}
	// Whose they are first: another customer's file is never read.
	if err := hd.CheckAttachments(ctx, tx, p.WorkspaceID, ids, hd.Uploader{Contact: &p.ContactID}); err != nil {
		return nil, err
	}
	if err := hd.CheckAttachmentFiles(ctx, s.d.Storage, tx, p.WorkspaceID, ids, acceptFile); err != nil {
		return nil, err
	}
	return ids, nil
}

// attachmentsOf loads the files of the given messages, for a page of a conversation. Inline
// pictures of an email's layout are not files the customer sent or can open apart from it.
func attachmentsOf(ctx context.Context, q db.Querier, wid uuid.UUID, messageIDs []uuid.UUID) (map[uuid.UUID][]customerAttachment, error) {
	out := map[uuid.UUID][]customerAttachment{}
	if len(messageIDs) == 0 {
		return out, nil
	}
	rows, err := q.Query(ctx, `SELECT message_id, id, filename, content_type, size_bytes FROM attachments
		WHERE workspace_id = $1 AND message_id = ANY($2) AND NOT inline ORDER BY created_at, id`, wid, messageIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var mid uuid.UUID
		var a customerAttachment
		if err := rows.Scan(&mid, &a.ID, &a.Filename, &a.ContentType, &a.SizeBytes); err != nil {
			return nil, err
		}
		a.URL = domain.AttachmentURL(a.ID)
		out[mid] = append(out[mid], a)
	}
	return out, rows.Err()
}
