package voys

import (
	"strings"
	"testing"
)

// The recording address of an event is kept only when it is on Voys' own API host: Voys signs
// nothing, so the token must never be sent where an unsigned event says.
func TestRecordingAddressIsVoysOwn(t *testing.T) {
	a := Adapter{}
	good := "https://api.voys.nl/api/v2/clients/c/callrecordings/1/audio"
	for _, raw := range []string{good, " " + good + " ", "https://API.voys.nl/x"} {
		if got := a.recordingAddress(raw); got == "" {
			t.Errorf("%q refused", raw)
		}
	}
	for _, raw := range []string{"", "http://api.voys.nl/x", "https://evil.example/api.voys.nl", "https://api.voys.nl.evil.example/x",
		"https://api.voys.nl@evil.example/x", "https://user:pw@api.voys.nl/x", "//evil.example/x", "/relative", "https://api.voys.nl:444/x",
		"https://evil.example/x?h=api.voys.nl", "https://api.voys.nl/" + strings.Repeat("a", 2000)} {
		if got := a.recordingAddress(raw); got != "" {
			t.Errorf("%q kept as %q", raw, got)
		}
	}
	ev, err := a.Parse([]byte(`{"call_id":"c1","recording_url":"` + good + `"}`))
	if err != nil || ev.Call == nil || !ev.Call.Recording || ev.Call.RecordingURL != good {
		t.Fatalf("event %+v %v", ev, err)
	}
	ev, err = a.Parse([]byte(`{"call_id":"c1","recording_url":"https://evil.example/x"}`))
	if err != nil || ev.Call == nil || !ev.Call.Recording || ev.Call.RecordingURL != "" {
		t.Fatalf("a foreign address was kept: %+v %v", ev, err)
	}
}
